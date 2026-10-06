use crate::library::LibraryState;
use dcpdoctor_core::{Severity, VerifyOptions, VerifyResult};
use postkit::job_queue::{JobInfo, JobState, QueueJob};
use postkit::package_library::{Verdict, VerdictState};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const JOBS_FILE: &str = "jobs.jsonl";
const JOBS_FILE_ENVIRONMENT_VARIABLE: &str = "DCPSCREEN_JOBS_FILE";
const VERIFY_STOPPED_MESSAGE: &str = "dcpdoctor stopped without a verdict";
// a verification runs in a copy of the app started with this, so a cancel can kill it and the ffmpeg it runs
const VERIFY_CHILD_ARGUMENT: &str = "--verify-package";
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Serialize, Deserialize)]
pub struct VerifyJob {
    pub id: u64,
    pub title: String,
    pub directory: PathBuf,
}

impl QueueJob for VerifyJob {
    fn id(&self) -> u64 {
        self.id
    }

    fn title(&self) -> &str {
        &self.title
    }

    fn output_dir(&self) -> Option<&Path> {
        None
    }
}

pub type JobQueue = postkit::job_queue::JobQueue<VerifyJob>;

pub fn jobs_path() -> PathBuf {
    postkit::job_queue::jobs_path(
        JOBS_FILE_ENVIRONMENT_VARIABLE,
        crate::data_dir().join(JOBS_FILE),
    )
}

pub struct VerifyWorker(mpsc::Sender<()>);

impl VerifyWorker {
    pub fn wake(&self) {
        self.0
            .send(())
            .expect("the verify worker thread has stopped");
    }
}

// the queue tracks one running job at a time
pub fn start_worker(app: AppHandle) -> VerifyWorker {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for () in receiver {
            run_queued_jobs(&app);
        }
    });
    let worker = VerifyWorker(sender);
    // runs what the last run left queued
    worker.wake();
    worker
}

fn run_queued_jobs(app: &AppHandle) {
    let queue = app.state::<JobQueue>();
    let library = app.state::<LibraryState>();
    while let Some(job) = queue.take_next() {
        queue.start(&job);
        let (state, message, verdict) =
            match verify_in_child(&job.directory, || queue.is_cancelled()) {
                None => (JobState::Cancelled, String::new(), Verdict::default()),
                Some(Ok(verdict)) => {
                    let message = format!("errors: {}", verdict.error_count);
                    (JobState::Completed, message, verdict)
                }
                Some(Err(message)) => (JobState::Failed, message, Verdict::default()),
            };
        match library.set_verdict(&job.directory, verdict) {
            Ok(()) => queue.finish(&job, state, &message),
            Err(error) => queue.finish(&job, JobState::Failed, &error),
        }
    }
    queue.clear_current();
}

// the package a copy of the app started by `verify_in_child` verifies
pub fn verify_child_directory() -> Option<PathBuf> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next()? != VERIFY_CHILD_ARGUMENT {
        return None;
    }
    arguments.next().map(PathBuf::from)
}

pub fn print_verdict(directory: &Path) {
    let result = dcpdoctor_core::verify(directory, &VerifyOptions::strict());
    let verdict = verdict_from(&result, now_rfc3339());
    println!(
        "{}",
        serde_json::to_string(&verdict).expect("a verdict serializes")
    );
}

// None once cancelled
fn verify_in_child(
    directory: &Path,
    is_cancelled: impl Fn() -> bool,
) -> Option<Result<Verdict, String>> {
    let program = match std::env::current_exe() {
        Ok(program) => program,
        Err(error) => return Some(Err(format!("cannot find the app to verify with: {error}"))),
    };
    let mut command = Command::new(program);
    command.arg(VERIFY_CHILD_ARGUMENT).arg(directory);
    let (status, stdout) = match output_unless_cancelled(command, is_cancelled) {
        Ok(output) => output?,
        Err(error) => return Some(Err(format!("cannot start the verification: {error}"))),
    };
    if !status.success() {
        return Some(Err(format!("{VERIFY_STOPPED_MESSAGE}: {status}")));
    }
    Some(
        serde_json::from_str(&stdout).map_err(|error| format!("{VERIFY_STOPPED_MESSAGE}: {error}")),
    )
}

// None once cancel killed the child and every process it started
fn output_unless_cancelled(
    mut command: Command,
    is_cancelled: impl Fn() -> bool,
) -> std::io::Result<Option<(ExitStatus, String)>> {
    command.stdout(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text)
    });
    loop {
        if let Some(status) = child.try_wait()? {
            let text = reader.join().expect("the stdout reader panicked")?;
            return Ok(Some((status, text)));
        }
        if is_cancelled() {
            kill_process_group(&mut child)?;
            child.wait()?;
            return Ok(None);
        }
        std::thread::sleep(CANCEL_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn kill_process_group(child: &mut std::process::Child) -> std::io::Result<()> {
    let group = i32::try_from(child.id()).expect("a process id fits an i32");
    // SAFETY: kill takes plain integers, a negative pid names the child's process group
    if unsafe { libc::kill(-group, libc::SIGKILL) } == 0 {
        return Ok(());
    }
    Err(std::io::Error::last_os_error())
}

#[cfg(not(unix))]
fn kill_process_group(child: &mut std::process::Child) -> std::io::Result<()> {
    child.kill()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn verdict_from(result: &VerifyResult, verified_at: String) -> Verdict {
    let error_count = result
        .notes
        .iter()
        .filter(|note| note.severity == Severity::Error)
        .count() as u32;
    let state = if error_count == 0 {
        VerdictState::Valid
    } else {
        VerdictState::Failed
    };
    Verdict {
        state,
        error_count,
        verified_at: Some(verified_at),
    }
}

#[tauri::command(async)]
pub fn list_jobs(queue: tauri::State<'_, JobQueue>) -> Vec<JobInfo> {
    queue.snapshot()
}

#[tauri::command(async)]
pub fn cancel_job(job_id: u64, queue: tauri::State<'_, JobQueue>) {
    queue.cancel(job_id);
}

#[tauri::command(async)]
pub fn move_job(
    job_id: u64,
    before_job_id: Option<u64>,
    queue: tauri::State<'_, JobQueue>,
) -> bool {
    queue.move_before(job_id, before_job_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dcpdoctor_core::{Code, Note};

    const VERIFIED_AT: &str = "2026-10-06T12:00:00Z";

    fn note(severity: Severity) -> Note {
        Note {
            severity,
            code: Code::AssetNotFound,
            message: String::new(),
            file: None,
            line: 0,
        }
    }

    #[test]
    fn error_notes_alone_make_the_verdict_failed_and_are_counted() {
        let result = VerifyResult {
            notes: vec![
                note(Severity::Error),
                note(Severity::Warning),
                note(Severity::Info),
                note(Severity::Error),
            ],
            ..Default::default()
        };

        assert_eq!(
            verdict_from(&result, VERIFIED_AT.into()),
            Verdict {
                state: VerdictState::Failed,
                error_count: 2,
                verified_at: Some(VERIFIED_AT.into()),
            }
        );
    }

    #[test]
    fn warnings_alone_leave_the_package_valid() {
        let result = VerifyResult {
            notes: vec![note(Severity::Warning), note(Severity::Info)],
            ..Default::default()
        };

        assert_eq!(
            verdict_from(&result, VERIFIED_AT.into()),
            Verdict {
                state: VerdictState::Valid,
                error_count: 0,
                verified_at: Some(VERIFIED_AT.into()),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_a_running_verification_and_the_process_it_started_within_a_second() {
        let directory = tempfile::tempdir().unwrap();
        let started_pid_file = directory.path().join("started.pid");
        let mut command = Command::new("sh");
        command.arg("-c").arg(format!(
            "sleep 60 & echo $! > {}; wait",
            started_pid_file.display()
        ));
        let cancel_at = std::sync::Mutex::new(None);

        let output = output_unless_cancelled(command, || {
            if !started_pid_file.exists() {
                return false;
            }
            cancel_at
                .lock()
                .unwrap()
                .get_or_insert_with(std::time::Instant::now);
            true
        })
        .unwrap();

        assert!(output.is_none());
        let stopped_after = cancel_at.lock().unwrap().unwrap().elapsed();
        assert!(stopped_after < Duration::from_secs(1), "{stopped_after:?}");
        let started_pid = std::fs::read_to_string(&started_pid_file).unwrap();
        let started_process = PathBuf::from(format!("/proc/{}", started_pid.trim()));
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while started_process.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(CANCEL_POLL_INTERVAL);
        }
        assert!(
            !started_process.exists(),
            "the sleep the job started still runs"
        );
    }

    #[test]
    fn a_child_that_finishes_hands_back_its_output() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("echo verdict");

        let (status, stdout) = output_unless_cancelled(command, || false).unwrap().unwrap();

        assert!(status.success());
        assert_eq!(stdout, "verdict\n");
    }

    #[test]
    fn a_package_with_schema_violations_fails_strict_verification() {
        let directory = tempfile::tempdir().unwrap();
        crate::test_fixtures::write_package(directory.path(), &[crate::test_fixtures::FEATURE]);

        let result = dcpdoctor_core::verify(directory.path(), &VerifyOptions::strict());
        let verdict = verdict_from(&result, VERIFIED_AT.into());

        assert_eq!(verdict.state, VerdictState::Failed);
        assert_eq!(verdict.error_count, result.error_count);
    }
}

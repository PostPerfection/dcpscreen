use crate::library::LibraryState;
use dcpdoctor_core::{Severity, VerifyOptions, VerifyResult};
use postkit::job_queue::{JobInfo, JobState, QueueJob};
use postkit::package_library::{Verdict, VerdictState};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use tauri::{AppHandle, Manager};

const JOBS_FILE: &str = "jobs.jsonl";
const JOBS_FILE_ENVIRONMENT_VARIABLE: &str = "DCPSCREEN_JOBS_FILE";
const VERIFY_PANICKED_MESSAGE: &str = "dcpdoctor stopped with a panic";

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
        let directory = job.directory.clone();
        let verified = std::thread::spawn(move || {
            dcpdoctor_core::verify(&directory, &VerifyOptions::strict())
        })
        .join();
        let (state, message, verdict) = match verified {
            _ if queue.is_cancelled() => (JobState::Cancelled, String::new(), Verdict::default()),
            Ok(result) => {
                let verdict = verdict_from(&result, now_rfc3339());
                let message = format!("errors: {}", verdict.error_count);
                (JobState::Completed, message, verdict)
            }
            Err(_) => (
                JobState::Failed,
                VERIFY_PANICKED_MESSAGE.to_string(),
                Verdict::default(),
            ),
        };
        match library.set_verdict(&job.directory, verdict) {
            Ok(()) => queue.finish(&job, state, &message),
            Err(error) => queue.finish(&job, JobState::Failed, &error),
        }
    }
    queue.clear_current();
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

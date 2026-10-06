use crate::settings::{settings_path, Settings};
use crate::verify_jobs::{JobQueue, VerifyJob, VerifyWorker};
use postkit::package_library::{
    refresh, CompositionEntry, Library, LibraryEntry, RefreshReport, Standard, Verdict,
    VerdictState,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const LIBRARY_FILE: &str = "library.json";
const VERIFY_JOB_TITLE_PREFIX: &str = "Verify";

pub fn library_path() -> PathBuf {
    crate::data_dir().join(LIBRARY_FILE)
}

pub struct LibraryState(Mutex<Library>);

impl LibraryState {
    pub fn load(path: PathBuf) -> Result<LibraryState, String> {
        Ok(LibraryState(Mutex::new(Library::load(&path)?)))
    }

    pub fn lock(&self) -> MutexGuard<'_, Library> {
        self.0.lock().unwrap()
    }

    pub fn refresh(&self, roots: &[PathBuf]) -> Result<String, String> {
        let mut library = self.lock();
        let report = refresh(&mut library, roots);
        library.save()?;
        for (_, reason) in &report.unreadable {
            eprintln!("[library] {reason}");
        }
        Ok(refresh_summary(&report))
    }

    pub fn set_verdict(&self, directory: &Path, verdict: Verdict) -> Result<(), String> {
        let mut library = self.lock();
        library.set_verdict(directory, verdict)?;
        library.save()
    }
}

fn refresh_summary(report: &RefreshReport) -> String {
    format!(
        "refresh: {} added, {} kept, {} removed, {} unreadable",
        report.added,
        report.kept,
        report.removed,
        report.unreadable.len()
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListing {
    status: String,
    packages: Vec<PackageRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageRow {
    directory: PathBuf,
    title: String,
    standard: &'static str,
    compositions: Vec<CompositionRow>,
    verdict: VerdictRow,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompositionRow {
    id: String,
    title: String,
    duration_frames: u64,
    edit_rate: [u32; 2],
    encrypted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerdictRow {
    state: VerdictState,
    error_count: u32,
    verified_at: Option<String>,
}

fn standard_name(standard: Standard) -> &'static str {
    match standard {
        Standard::Interop => "Interop",
        Standard::Smpte => "SMPTE",
    }
}

fn composition_row(composition: &CompositionEntry) -> CompositionRow {
    let (numerator, denominator) = composition.edit_rate;
    CompositionRow {
        id: composition.id.to_string(),
        title: composition.title.clone(),
        duration_frames: composition.duration_frames,
        edit_rate: [numerator, denominator],
        encrypted: composition.encrypted,
    }
}

fn package_row(entry: &LibraryEntry) -> PackageRow {
    PackageRow {
        directory: entry.package.directory.clone(),
        title: entry.package.title.clone(),
        standard: standard_name(entry.package.standard),
        compositions: entry
            .package
            .compositions
            .iter()
            .map(composition_row)
            .collect(),
        verdict: VerdictRow {
            state: entry.verdict.state,
            error_count: entry.verdict.error_count,
            verified_at: entry.verdict.verified_at.clone(),
        },
    }
}

pub fn library_listing(library: &Library) -> LibraryListing {
    LibraryListing {
        status: format!("Packages: {}", library.entries().len()),
        packages: library.entries().iter().map(package_row).collect(),
    }
}

#[tauri::command(async)]
pub fn library_list(library: tauri::State<'_, LibraryState>) -> LibraryListing {
    library_listing(&library.lock())
}

#[tauri::command(async)]
pub fn library_refresh(library: tauri::State<'_, LibraryState>) -> Result<String, String> {
    let settings = Settings::load(&settings_path())?;
    let summary = library.refresh(&settings.library_roots)?;
    println!("[library] {summary}");
    Ok(summary)
}

#[tauri::command(async)]
pub fn library_verify(
    directory: PathBuf,
    library: tauri::State<'_, LibraryState>,
    queue: tauri::State<'_, JobQueue>,
    worker: tauri::State<'_, VerifyWorker>,
) -> Result<(), String> {
    let mut entries = library.lock();
    let title = entries
        .entry(&directory)
        .ok_or_else(|| format!("{} is not in the library", directory.display()))?
        .package
        .title
        .clone();
    let verifying = Verdict {
        state: VerdictState::Verifying,
        ..Default::default()
    };
    entries.set_verdict(&directory, verifying)?;
    entries.save()?;
    queue.submit(VerifyJob {
        id: queue.reserve_job_id(),
        title: format!("{VERIFY_JOB_TITLE_PREFIX} {title}"),
        directory,
    });
    worker.wake();
    Ok(())
}

#[tauri::command(async)]
pub fn library_remove(
    directory: PathBuf,
    library: tauri::State<'_, LibraryState>,
) -> Result<(), String> {
    let mut entries = library.lock();
    entries.remove(&directory);
    entries.save()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::{write_package, FEATURE, FEATURE_ID, TRAILER, TRAILER_ID};
    use serde_json::json;

    const VERIFIED_AT: &str = "2026-10-06T12:00:00Z";

    #[test]
    fn the_listing_carries_the_panel_contract_for_every_package() {
        let root = tempfile::tempdir().unwrap();
        let feature = root.path().join("feature");
        let trailer = root.path().join("trailer");
        write_package(&feature, &[FEATURE]);
        write_package(&trailer, &[TRAILER]);
        let state = LibraryState::load(root.path().join(LIBRARY_FILE)).unwrap();
        let summary = state.refresh(&[root.path().to_path_buf()]).unwrap();
        let failed = Verdict {
            state: VerdictState::Failed,
            error_count: 3,
            verified_at: Some(VERIFIED_AT.into()),
        };
        state.set_verdict(&feature, failed).unwrap();

        let listing = serde_json::to_value(library_listing(&state.lock())).unwrap();

        assert_eq!(summary, "refresh: 2 added, 0 kept, 0 removed, 0 unreadable");
        assert_eq!(
            listing,
            json!({
                "status": "Packages: 2",
                "packages": [
                    {
                        "directory": feature.display().to_string(),
                        "title": "Feature & Credits",
                        "standard": "SMPTE",
                        "compositions": [{
                            "id": FEATURE_ID,
                            "title": "Feature & Credits",
                            "durationFrames": 840,
                            "editRate": [24, 1],
                            "encrypted": false,
                        }],
                        "verdict": {
                            "state": "Failed",
                            "errorCount": 3,
                            "verifiedAt": VERIFIED_AT,
                        },
                    },
                    {
                        "directory": trailer.display().to_string(),
                        "title": "Trailer",
                        "standard": "SMPTE",
                        "compositions": [{
                            "id": TRAILER_ID,
                            "title": "Trailer",
                            "durationFrames": 250,
                            "editRate": [25, 1],
                            "encrypted": true,
                        }],
                        "verdict": {
                            "state": "Unverified",
                            "errorCount": 0,
                            "verifiedAt": null,
                        },
                    },
                ],
            })
        );
    }

    #[test]
    fn a_verdict_set_through_the_state_is_saved_to_the_library_file() {
        let root = tempfile::tempdir().unwrap();
        let feature = root.path().join("feature");
        write_package(&feature, &[FEATURE]);
        let path = root.path().join(LIBRARY_FILE);
        let state = LibraryState::load(path.clone()).unwrap();
        state.refresh(&[root.path().to_path_buf()]).unwrap();
        let valid = Verdict {
            state: VerdictState::Valid,
            error_count: 0,
            verified_at: Some(VERIFIED_AT.into()),
        };

        state.set_verdict(&feature, valid.clone()).unwrap();

        let saved = Library::load(&path).unwrap();
        assert_eq!(saved.entry(&feature).unwrap().verdict, valid);
    }
}

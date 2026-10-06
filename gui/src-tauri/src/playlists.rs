use crate::library::LibraryState;
use crate::play::row_source;
use guikit::preview::screening_runner::{RunnerState, ScreeningRunner};
use postkit::package_library::Library;
use postkit::screening_playlist::{plan, PlaylistPlan, ScreeningPlaylist};
use std::path::{Path, PathBuf};
use tauri::Manager;

const PLAYLISTS_DIRECTORY: &str = "playlists";
const PLAYLIST_EXTENSION: &str = "json";
const FORBIDDEN_NAME_CHARACTERS: [char; 2] = ['/', '\\'];

pub fn playlists_directory() -> PathBuf {
    crate::data_dir().join(PLAYLISTS_DIRECTORY)
}

// the name is the file name, so it may not climb out of the playlists directory or hide the file
pub fn playlist_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    let refused = trimmed.is_empty()
        || trimmed.starts_with('.')
        || trimmed.contains(FORBIDDEN_NAME_CHARACTERS)
        || trimmed.chars().any(char::is_control);
    if refused {
        return Err(format!(
            "{name:?} cannot name a playlist: use a name with no slash that does not start with a dot"
        ));
    }
    Ok(directory.join(format!("{trimmed}.{PLAYLIST_EXTENSION}")))
}

pub fn playlist_names(directory: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{}: {error}", directory.display())),
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == PLAYLIST_EXTENSION)
        })
        .filter_map(|path| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    Ok(names)
}

fn composition_seconds(library: &Library, directory: &Path, cpl_id: uuid::Uuid) -> Option<f64> {
    let composition = library
        .entry(directory)?
        .package
        .compositions
        .iter()
        .find(|composition| composition.id == cpl_id)?;
    let (numerator, denominator) = composition.edit_rate;
    if numerator == 0 {
        return None;
    }
    Some(composition.duration_frames as f64 * f64::from(denominator) / f64::from(numerator))
}

#[tauri::command(async)]
pub fn playlist_list() -> Result<Vec<String>, String> {
    playlist_names(&playlists_directory())
}

#[tauri::command(async)]
pub fn playlist_open(name: String) -> Result<ScreeningPlaylist, String> {
    ScreeningPlaylist::read(&playlist_path(&playlists_directory(), &name)?)
}

#[tauri::command(async)]
pub fn playlist_save(playlist: ScreeningPlaylist) -> Result<(), String> {
    playlist.write(&playlist_path(&playlists_directory(), &playlist.name)?)
}

#[tauri::command(async)]
pub fn playlist_plan(
    playlist: ScreeningPlaylist,
    from_row: usize,
    library: tauri::State<'_, LibraryState>,
) -> PlaylistPlan {
    let library = library.lock();
    plan(
        &playlist.rows,
        from_row,
        chrono::Local::now().naive_local(),
        |directory, cpl_id| composition_seconds(&library, directory, cpl_id),
    )
}

#[tauri::command(async)]
pub fn playlist_play(
    playlist: ScreeningPlaylist,
    from_row: usize,
    app: tauri::AppHandle,
    runner: tauri::State<'_, ScreeningRunner>,
) -> RunnerState {
    let lookup_app = app.clone();
    runner.start(
        playlist,
        from_row,
        Box::new(move |directory, cpl_id| {
            row_source(&lookup_app.state::<LibraryState>(), directory, cpl_id)
        }),
    )
}

#[tauri::command(async)]
pub fn playlist_stop(runner: tauri::State<'_, ScreeningRunner>) {
    runner.stop();
}

#[tauri::command(async)]
pub fn playlist_state(runner: tauri::State<'_, ScreeningRunner>) -> Option<RunnerState> {
    runner.state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_becomes_a_json_file_in_the_playlists_directory() {
        let directory = Path::new("/data/playlists");
        assert_eq!(
            playlist_path(directory, " Friday evening ").unwrap(),
            directory.join("Friday evening.json")
        );
    }

    #[test]
    fn a_name_that_leaves_the_directory_or_hides_the_file_is_refused() {
        let directory = Path::new("/data/playlists");
        for name in [
            "",
            "  ",
            "../settings",
            "a/b",
            "a\\b",
            ".hidden",
            "tab\there",
        ] {
            assert!(
                playlist_path(directory, name).is_err(),
                "{name:?} was taken"
            );
        }
    }

    #[test]
    fn the_saved_playlists_are_listed_by_name_in_order() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["Saturday", "Friday"] {
            ScreeningPlaylist::new(name)
                .write(&playlist_path(directory.path(), name).unwrap())
                .unwrap();
        }
        std::fs::write(directory.path().join("notes.txt"), "not a playlist").unwrap();

        assert_eq!(
            playlist_names(directory.path()).unwrap(),
            ["Friday", "Saturday"]
        );
        assert_eq!(
            playlist_names(&directory.path().join("none yet")).unwrap(),
            Vec::<String>::new()
        );
    }
}

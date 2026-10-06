use crate::keys::{kdm_store_directory, load_store};
use crate::library::LibraryState;
use crate::settings::{settings_path, Settings};
use guikit::preview::screening_runner::RowSource;
use postkit::composition_timeline::find_original_version_packages;
use postkit::content_keys::ContentKeys;
use postkit::kdm_store::{KdmFit, KdmStore};
use postkit::package_library::Library;
use serde::Serialize;
use std::path::{Path, PathBuf};

const NO_RECIPIENT_KEY_MESSAGE: &str =
    "an encrypted composition needs the recipient key, set it in Settings";
const NO_KDM_FITS_MESSAGE: &str = "no KDM in the store fits it now";

#[derive(Debug, PartialEq, Serialize)]
pub struct ContentKeyPaths {
    kdm: PathBuf,
    recipient_key: PathBuf,
    keys: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedKdm {
    path: PathBuf,
    fit: KdmFit,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlaySource {
    Ready {
        cpl_path: PathBuf,
        content_keys: Option<ContentKeyPaths>,
        // the library packages a version file takes its original version's assets from
        other_packages: Vec<PathBuf>,
    },
    NoKdmFits {
        kdms: Vec<RefusedKdm>,
    },
}

pub fn play_source(
    library: &Library,
    store: &KdmStore,
    settings: &Settings,
    directory: &Path,
    cpl_id: uuid::Uuid,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<PlaySource, String> {
    let entry = library
        .entry(directory)
        .ok_or_else(|| format!("{} is not in the library", directory.display()))?;
    let composition = entry
        .package
        .compositions
        .iter()
        .find(|composition| composition.id == cpl_id)
        .ok_or_else(|| format!("{} holds no composition {cpl_id}", directory.display()))?;
    let cpl_path = postkit::assetmap::resolve(directory, &cpl_id.to_string()).ok_or_else(|| {
        format!(
            "the asset map in {} does not name CPL {cpl_id}",
            directory.display()
        )
    })?;
    let library_packages: Vec<PathBuf> = library
        .entries()
        .iter()
        .map(|entry| entry.package.directory.clone())
        .collect();
    let other_packages = find_original_version_packages(&cpl_path, &library_packages)?;
    if !composition.encrypted {
        return Ok(PlaySource::Ready {
            cpl_path,
            content_keys: None,
            other_packages,
        });
    }
    let recipient_key = settings
        .recipient_key
        .clone()
        .ok_or(NO_RECIPIENT_KEY_MESSAGE)?;
    let subject_name = settings.recipient_subject_name()?.unwrap_or_default();
    if let Some(kdm) = store.kdm_for_playback(cpl_id, now, &subject_name) {
        return Ok(PlaySource::Ready {
            cpl_path,
            content_keys: Some(ContentKeyPaths {
                kdm: kdm.path.clone(),
                recipient_key,
                keys: None,
            }),
            other_packages,
        });
    }
    let kdms = store
        .kdms_for(cpl_id, now, &subject_name)
        .into_iter()
        .map(|(stored, fit)| RefusedKdm {
            path: stored.path.clone(),
            fit,
        })
        .collect();
    Ok(PlaySource::NoKdmFits { kdms })
}

// with the settings and the KDM store as they are now
fn play_source_now(
    library: &LibraryState,
    directory: &Path,
    cpl_id: uuid::Uuid,
) -> Result<PlaySource, String> {
    let settings = Settings::load(&settings_path())?;
    let store = load_store(&kdm_store_directory());
    play_source(
        &library.lock(),
        &store,
        &settings,
        directory,
        cpl_id,
        chrono::Utc::now(),
    )
}

#[tauri::command(async)]
pub fn library_play(
    directory: PathBuf,
    cpl_id: String,
    library: tauri::State<'_, LibraryState>,
) -> Result<PlaySource, String> {
    let cpl_id = uuid::Uuid::parse_str(&cpl_id).map_err(|error| format!("{cpl_id}: {error}"))?;
    play_source_now(&library, &directory, cpl_id)
}

// a playlist row picks its KDM when it loads, so a KDM ingested during the show counts
pub fn row_source(
    library: &LibraryState,
    directory: &Path,
    cpl_id: uuid::Uuid,
) -> Result<RowSource, String> {
    row_source_from(play_source_now(library, directory, cpl_id)?)
}

fn row_source_from(source: PlaySource) -> Result<RowSource, String> {
    match source {
        PlaySource::Ready {
            cpl_path,
            content_keys,
            other_packages,
        } => {
            let keys = match content_keys {
                Some(paths) => ContentKeys::from_options(
                    Some(&paths.kdm),
                    Some(&paths.recipient_key),
                    paths.keys.as_deref(),
                )?,
                None => None,
            };
            Ok(RowSource {
                cpl_path,
                keys,
                other_packages,
            })
        }
        PlaySource::NoKdmFits { .. } => Err(NO_KDM_FITS_MESSAGE.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::{
        cpl_file_name, other_recipient_chain, picture_id, recipient_chain, uuid, write_kdm,
        write_package, write_package_holding, KdmWindow, FEATURE, FEATURE_ID, ORIGINAL_VERSION,
        TRAILER, TRAILER_ID,
    };
    use chrono::{DateTime, Duration, SubsecRound, Utc};
    use guikit::preview::screening_runner::{PlayerStatus, RunnerPlayer, ScreeningRun};
    use postkit::grok_player::SourceOptions;
    use postkit::screening_playlist::{PlaylistRow, RowItem, ScreeningPlaylist};
    use serde_json::json;
    use std::cell::RefCell;

    const DAYS_UNTIL_NOW: i64 = 6;
    const EXPIRED_FILE: &str = "a_expired.xml";
    const VALID_EARLY_FILE: &str = "b_valid_early.xml";
    const VALID_LATE_FILE: &str = "c_valid_late.xml";
    const OTHER_RECIPIENT_FILE: &str = "d_other_recipient.xml";

    struct Fixture {
        root: tempfile::TempDir,
        package: PathBuf,
        kdms: PathBuf,
        library: Library,
        base: DateTime<Utc>,
    }

    impl Fixture {
        fn now(&self) -> DateTime<Utc> {
            self.base + Duration::days(DAYS_UNTIL_NOW)
        }

        fn kdm(&self, name: &str) -> PathBuf {
            self.kdms.join(name)
        }

        fn play(&self, settings: &Settings, cpl_id: &str) -> Result<PlaySource, String> {
            play_source(
                &self.library,
                &load_store(&self.kdms),
                settings,
                &self.package,
                uuid(cpl_id),
                self.now(),
            )
        }
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("library").join("feature");
        write_package(&package, &[FEATURE, TRAILER]);
        let mut library = Library::load(&root.path().join("library.json")).unwrap();
        postkit::package_library::refresh(&mut library, &[root.path().join("library")]);
        let kdms = root.path().join("kdms");
        std::fs::create_dir(&kdms).unwrap();
        let base = Utc::now().trunc_subsecs(0);
        let windows = [
            (EXPIRED_FILE, recipient_chain(), 1, 4),
            (VALID_EARLY_FILE, recipient_chain(), 3, 7),
            (VALID_LATE_FILE, recipient_chain(), 5, 9),
            (OTHER_RECIPIENT_FILE, other_recipient_chain(), 5, 10),
        ];
        for (name, recipient, first_day, last_day) in windows {
            write_kdm(
                &kdms.join(name),
                recipient,
                TRAILER_ID,
                base,
                KdmWindow {
                    first_day,
                    last_day,
                },
            );
        }
        Fixture {
            root,
            package,
            kdms,
            library,
            base,
        }
    }

    fn recipient_settings() -> Settings {
        Settings {
            recipient_certificate: Some(recipient_chain().certificate.clone()),
            recipient_key: Some(recipient_chain().key.clone()),
            ..Default::default()
        }
    }

    #[test]
    fn a_plain_composition_plays_its_cpl_with_no_keys() {
        let fixture = fixture();

        let source = fixture.play(&Settings::default(), FEATURE_ID).unwrap();

        assert_eq!(
            serde_json::to_value(source).unwrap(),
            json!({
                "kind": "ready",
                "cplPath": fixture.package.join(cpl_file_name(FEATURE_ID)).display().to_string(),
                "contentKeys": null,
                "otherPackages": [],
            })
        );
    }

    #[test]
    fn an_encrypted_composition_plays_with_the_valid_kdm_that_ends_last() {
        let fixture = fixture();

        let source = fixture.play(&recipient_settings(), TRAILER_ID).unwrap();

        assert_eq!(
            serde_json::to_value(source).unwrap(),
            json!({
                "kind": "ready",
                "cplPath": fixture.package.join(cpl_file_name(TRAILER_ID)).display().to_string(),
                "contentKeys": {
                    "kdm": fixture.kdm(VALID_LATE_FILE).display().to_string(),
                    "recipient_key": recipient_chain().key.display().to_string(),
                    "keys": null,
                },
                "otherPackages": [],
            })
        );
    }

    #[test]
    fn with_no_kdm_valid_now_every_kdm_is_listed_with_why_it_does_not_fit() {
        let fixture = fixture();
        for name in [VALID_EARLY_FILE, VALID_LATE_FILE] {
            std::fs::remove_file(fixture.kdm(name)).unwrap();
        }

        let source = fixture.play(&recipient_settings(), TRAILER_ID).unwrap();

        assert_eq!(
            serde_json::to_value(source).unwrap(),
            json!({
                "kind": "noKdmFits",
                "kdms": [
                    { "path": fixture.kdm(EXPIRED_FILE).display().to_string(), "fit": "Expired" },
                    { "path": fixture.kdm(OTHER_RECIPIENT_FILE).display().to_string(), "fit": "WrongRecipient" },
                ],
            })
        );
    }

    #[test]
    fn with_no_certificate_every_kdm_naming_a_recipient_is_refused() {
        let fixture = fixture();
        let settings = Settings {
            recipient_key: Some(recipient_chain().key.clone()),
            ..Default::default()
        };

        let source = fixture.play(&settings, TRAILER_ID).unwrap();

        let PlaySource::NoKdmFits { kdms } = source else {
            panic!("played without a certificate: {source:?}");
        };
        let fits: Vec<KdmFit> = kdms.iter().map(|refused| refused.fit).collect();
        assert_eq!(fits, [KdmFit::WrongRecipient; 4]);
    }

    #[test]
    fn an_encrypted_composition_without_a_recipient_key_is_an_error() {
        let fixture = fixture();
        let settings = Settings {
            recipient_certificate: Some(recipient_chain().certificate.clone()),
            ..Default::default()
        };

        assert_eq!(
            fixture.play(&settings, TRAILER_ID),
            Err(NO_RECIPIENT_KEY_MESSAGE.to_string())
        );
    }

    #[test]
    fn a_directory_outside_the_library_is_an_error_naming_it() {
        let fixture = fixture();
        let elsewhere = fixture.root.path().join("elsewhere");

        let source = play_source(
            &fixture.library,
            &load_store(&fixture.kdms),
            &Settings::default(),
            &elsewhere,
            uuid(FEATURE_ID),
            fixture.now(),
        );

        assert_eq!(
            source,
            Err(format!("{} is not in the library", elsewhere.display()))
        );
    }

    // reel 2 of the version file is only in the original version
    const ORIGINAL_VERSION_REEL: usize = 1;
    // the feature is not encrypted, so it plays with an empty store
    const ABSENT_KDM_DIRECTORY: &str = "no kdms";

    struct VersionFileLibrary {
        _root: tempfile::TempDir,
        version_file: PathBuf,
        original_version: PathBuf,
        library: Library,
    }

    fn version_file_library(with_original_version: bool) -> VersionFileLibrary {
        let root = tempfile::tempdir().unwrap();
        let library_root = root.path().join("library");
        let version_file = library_root.join("feature_vf");
        let original_version = library_root.join("feature_ov");
        write_package_holding(&version_file, &[FEATURE], |reel| {
            reel != ORIGINAL_VERSION_REEL
        });
        if with_original_version {
            write_package(&original_version, &[ORIGINAL_VERSION]);
        }
        let mut library = Library::load(&root.path().join("library.json")).unwrap();
        postkit::package_library::refresh(&mut library, &[library_root]);
        VersionFileLibrary {
            _root: root,
            version_file,
            original_version,
            library,
        }
    }

    fn play_from(library: &Library, directory: &Path) -> Result<PlaySource, String> {
        play_source(
            library,
            &load_store(&directory.join(ABSENT_KDM_DIRECTORY)),
            &Settings::default(),
            directory,
            uuid(FEATURE_ID),
            chrono::Utc::now(),
        )
    }

    #[test]
    fn a_version_file_plays_with_the_library_package_holding_its_original_version() {
        let fixture = version_file_library(true);

        let source = play_from(&fixture.library, &fixture.version_file).unwrap();

        assert_eq!(
            source,
            PlaySource::Ready {
                cpl_path: fixture.version_file.join(cpl_file_name(FEATURE_ID)),
                content_keys: None,
                other_packages: vec![fixture.original_version.clone()],
            }
        );
    }

    #[test]
    fn a_version_file_whose_original_version_is_not_in_the_library_names_the_missing_reel() {
        let fixture = version_file_library(false);

        let error = play_from(&fixture.library, &fixture.version_file).unwrap_err();

        assert_eq!(
            error,
            format!(
                "no package in the library holds {}",
                picture_id(ORIGINAL_VERSION_REEL)
            )
        );
    }

    #[derive(Default)]
    struct RecordingPlayer {
        loads: RefCell<Vec<(PathBuf, Vec<PathBuf>)>>,
        status: RefCell<PlayerStatus>,
    }

    impl RunnerPlayer for RecordingPlayer {
        fn load(&self, source: &Path, options: SourceOptions) -> Result<(), String> {
            self.status.borrow_mut().source = Some(source.display().to_string());
            self.loads
                .borrow_mut()
                .push((source.to_path_buf(), options.other_packages));
            Ok(())
        }

        fn queue_next(&self, source: &Path, _options: SourceOptions) -> Result<(), String> {
            Err(format!("{} queued with no row after it", source.display()))
        }

        fn stop(&self) -> Result<(), String> {
            Ok(())
        }

        fn status(&self) -> Result<PlayerStatus, String> {
            Ok(self.status.borrow().clone())
        }
    }

    #[test]
    fn a_playlist_row_of_a_version_file_loads_with_its_original_version() {
        let fixture = version_file_library(true);
        let mut playlist = ScreeningPlaylist::new("Evening");
        playlist.rows = vec![PlaylistRow {
            start_time: None,
            item: RowItem::Composition {
                package_directory: fixture.version_file.clone(),
                cpl_id: uuid(FEATURE_ID),
                title: FEATURE.title.to_string(),
                in_frame: None,
                out_frame: None,
            },
        }];
        let library = fixture.library.clone();
        let player = RecordingPlayer::default();

        let run = ScreeningRun::start(
            playlist,
            0,
            Box::new(move |directory, _cpl_id| row_source_from(play_from(&library, directory)?)),
            &player,
            chrono::Local::now().naive_local(),
        );

        assert!(run.is_running());
        assert_eq!(
            player.loads.take(),
            [(
                fixture.version_file.join(cpl_file_name(FEATURE_ID)),
                vec![fixture.original_version.clone()]
            )]
        );
    }
}

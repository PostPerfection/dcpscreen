use crate::settings::{LoadedSettings, Settings, SettingsFile};
use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const MINIMUM_PASSWORD_LENGTH: usize = 8;
const WRONG_PASSWORD_DELAY: Duration = Duration::from_secs(5);
const LOCKED_ERROR: &str = "settings are locked, unlock them in Settings";
const WRONG_PASSWORD_ERROR: &str = "wrong password";
const NO_PASSWORD_ERROR: &str = "settings have no password";
const PASSWORD_ALREADY_SET_ERROR: &str = "settings already have a password, change it instead";
const PASSWORDS_DIFFER_ERROR: &str = "the two new passwords differ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockState {
    NoPassword,
    Locked,
    Unlocked,
}

#[derive(Debug, Default)]
struct LockSession {
    unlocked: bool,
    // wrong passwords push this forward, attempts before it are refused unchecked
    next_attempt_at: Option<Instant>,
}

impl LockSession {
    fn state(&self, file: &SettingsFile) -> LockState {
        match (&file.settings_password_hash, self.unlocked) {
            (None, _) => LockState::NoPassword,
            (Some(_), false) => LockState::Locked,
            (Some(_), true) => LockState::Unlocked,
        }
    }

    fn check_password(
        &mut self,
        file: &SettingsFile,
        password: &str,
        now: Instant,
    ) -> Result<(), String> {
        let stored_hash = file
            .settings_password_hash
            .as_deref()
            .ok_or(NO_PASSWORD_ERROR)?;
        if let Some(next_attempt_at) = self.next_attempt_at.filter(|at| now < *at) {
            return Err(format!(
                "the next password attempt is accepted in {:.0} s",
                (next_attempt_at - now).as_secs_f64().ceil()
            ));
        }
        let stored_hash = PasswordHash::new(stored_hash)
            .map_err(|error| format!("the settings password hash does not read: {error}"))?;
        if Argon2::default()
            .verify_password(password.as_bytes(), &stored_hash)
            .is_err()
        {
            self.next_attempt_at = Some(now + WRONG_PASSWORD_DELAY);
            return Err(format!(
                "{WRONG_PASSWORD_ERROR}, the next attempt is accepted in {} s",
                WRONG_PASSWORD_DELAY.as_secs()
            ));
        }
        self.next_attempt_at = None;
        Ok(())
    }
}

fn new_password_hash(password: &str, confirmation: &str) -> Result<String, String> {
    if password != confirmation {
        return Err(PASSWORDS_DIFFER_ERROR.to_string());
    }
    if password.chars().count() < MINIMUM_PASSWORD_LENGTH {
        return Err(format!(
            "the password needs at least {MINIMUM_PASSWORD_LENGTH} characters"
        ));
    }
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|error| format!("the password does not hash: {error}"))
}

// every settings file write goes through here to keep the stored hash
pub struct SettingsLock {
    path: PathBuf,
    session: Mutex<LockSession>,
}

impl SettingsLock {
    pub fn new(path: PathBuf) -> SettingsLock {
        SettingsLock {
            path,
            session: Mutex::new(LockSession::default()),
        }
    }

    fn session(&self) -> MutexGuard<'_, LockSession> {
        self.session.lock().unwrap()
    }

    pub fn load_settings(&self) -> Result<LoadedSettings, String> {
        let session = self.session();
        let file = SettingsFile::load(&self.path)?;
        Ok(LoadedSettings {
            settings_lock: session.state(&file),
            settings: file.settings,
        })
    }

    pub fn refuse_while_locked(&self) -> Result<(), String> {
        let session = self.session();
        let file = SettingsFile::load(&self.path)?;
        if session.state(&file) == LockState::Locked {
            return Err(LOCKED_ERROR.to_string());
        }
        Ok(())
    }

    pub fn save_settings(&self, settings: Settings) -> Result<(), String> {
        let session = self.session();
        let file = SettingsFile::load(&self.path)?;
        if session.state(&file) == LockState::Locked {
            return Err(LOCKED_ERROR.to_string());
        }
        settings.recipient_subject_name()?;
        settings.check_display_profile()?;
        SettingsFile { settings, ..file }.save(&self.path)
    }

    pub fn set_password(&self, password: &str, confirmation: &str) -> Result<(), String> {
        let mut session = self.session();
        let file = SettingsFile::load(&self.path)?;
        if file.settings_password_hash.is_some() {
            return Err(PASSWORD_ALREADY_SET_ERROR.to_string());
        }
        let settings_password_hash = Some(new_password_hash(password, confirmation)?);
        SettingsFile {
            settings_password_hash,
            ..file
        }
        .save(&self.path)?;
        session.unlocked = false;
        Ok(())
    }

    pub fn change_password(
        &self,
        current_password: &str,
        password: &str,
        confirmation: &str,
        now: Instant,
    ) -> Result<(), String> {
        let mut session = self.session();
        let file = SettingsFile::load(&self.path)?;
        session.check_password(&file, current_password, now)?;
        let settings_password_hash = Some(new_password_hash(password, confirmation)?);
        SettingsFile {
            settings_password_hash,
            ..file
        }
        .save(&self.path)
    }

    pub fn remove_password(&self, current_password: &str, now: Instant) -> Result<(), String> {
        let mut session = self.session();
        let file = SettingsFile::load(&self.path)?;
        session.check_password(&file, current_password, now)?;
        SettingsFile {
            settings_password_hash: None,
            ..file
        }
        .save(&self.path)
    }

    pub fn unlock(&self, password: &str, now: Instant) -> Result<(), String> {
        let mut session = self.session();
        let file = SettingsFile::load(&self.path)?;
        session.check_password(&file, password, now)?;
        session.unlocked = true;
        Ok(())
    }

    pub fn lock(&self) {
        self.session().unlocked = false;
    }
}

#[tauri::command(async)]
pub fn settings_lock_set(
    password: String,
    confirmation: String,
    lock: tauri::State<'_, SettingsLock>,
) -> Result<(), String> {
    lock.set_password(&password, &confirmation)
}

#[tauri::command(async)]
pub fn settings_lock_change(
    current_password: String,
    password: String,
    confirmation: String,
    lock: tauri::State<'_, SettingsLock>,
) -> Result<(), String> {
    lock.change_password(&current_password, &password, &confirmation, Instant::now())
}

#[tauri::command(async)]
pub fn settings_lock_remove(
    current_password: String,
    lock: tauri::State<'_, SettingsLock>,
) -> Result<(), String> {
    lock.remove_password(&current_password, Instant::now())
}

#[tauri::command(async)]
pub fn settings_unlock(
    password: String,
    lock: tauri::State<'_, SettingsLock>,
) -> Result<(), String> {
    lock.unlock(&password, Instant::now())
}

#[tauri::command(async)]
pub fn settings_lock(lock: tauri::State<'_, SettingsLock>) {
    lock.lock();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const PASSWORD: &str = "projectionist";
    const OTHER_PASSWORD: &str = "booth-operator";
    const SETTINGS_FILE: &str = "settings.json";

    fn stored_hash(lock: &SettingsLock) -> Option<String> {
        SettingsFile::load(&lock.path)
            .unwrap()
            .settings_password_hash
    }

    fn state(lock: &SettingsLock) -> LockState {
        lock.load_settings().unwrap().settings_lock
    }

    fn locked_settings(directory: &tempfile::TempDir) -> SettingsLock {
        let lock = SettingsLock::new(directory.path().join(SETTINGS_FILE));
        lock.save_settings(Settings {
            library_roots: vec![PathBuf::from("/srv/dcp")],
            ..Default::default()
        })
        .unwrap();
        lock.set_password(PASSWORD, PASSWORD).unwrap();
        lock
    }

    #[test]
    fn setting_a_password_stores_an_argon2id_hash_and_locks() {
        let directory = tempfile::tempdir().unwrap();

        let lock = locked_settings(&directory);

        let hash = stored_hash(&lock).unwrap();
        assert!(hash.starts_with("$argon2id$v=19$"), "{hash}");
        assert!(!hash.contains(PASSWORD));
        assert_eq!(state(&lock), LockState::Locked);
        assert_eq!(
            lock.load_settings().unwrap().settings.library_roots,
            vec![PathBuf::from("/srv/dcp")]
        );
    }

    #[test]
    fn two_passwords_get_different_salts() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();

        let first_hash = stored_hash(&locked_settings(&first)).unwrap();
        let second_hash = stored_hash(&locked_settings(&second)).unwrap();

        assert_ne!(first_hash, second_hash);
    }

    #[test]
    fn a_short_or_mismatched_new_password_is_refused_and_nothing_is_stored() {
        let directory = tempfile::tempdir().unwrap();
        let lock = SettingsLock::new(directory.path().join(SETTINGS_FILE));

        let short = "a".repeat(MINIMUM_PASSWORD_LENGTH - 1);
        assert_eq!(
            lock.set_password(&short, &short).unwrap_err(),
            format!("the password needs at least {MINIMUM_PASSWORD_LENGTH} characters")
        );
        assert_eq!(
            lock.set_password(PASSWORD, OTHER_PASSWORD).unwrap_err(),
            PASSWORDS_DIFFER_ERROR
        );
        assert_eq!(stored_hash(&lock), None);
        assert_eq!(state(&lock), LockState::NoPassword);
    }

    #[test]
    fn setting_a_second_password_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let hash = stored_hash(&lock);

        assert_eq!(
            lock.set_password(OTHER_PASSWORD, OTHER_PASSWORD)
                .unwrap_err(),
            PASSWORD_ALREADY_SET_ERROR
        );
        assert_eq!(stored_hash(&lock), hash);
    }

    #[test]
    fn the_right_password_unlocks_until_lock() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);

        lock.unlock(PASSWORD, Instant::now()).unwrap();
        assert_eq!(state(&lock), LockState::Unlocked);
        lock.refuse_while_locked().unwrap();

        lock.lock();
        assert_eq!(state(&lock), LockState::Locked);
        assert_eq!(lock.refuse_while_locked().unwrap_err(), LOCKED_ERROR);
    }

    #[test]
    fn a_wrong_password_stays_locked_and_holds_off_the_next_attempt() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let start = Instant::now();

        let error = lock.unlock(OTHER_PASSWORD, start).unwrap_err();
        assert!(error.starts_with(WRONG_PASSWORD_ERROR), "{error}");
        assert_eq!(state(&lock), LockState::Locked);

        let too_soon = start + WRONG_PASSWORD_DELAY - Duration::from_millis(1);
        assert_eq!(
            lock.unlock(PASSWORD, too_soon).unwrap_err(),
            "the next password attempt is accepted in 1 s"
        );
        assert!(lock
            .remove_password(PASSWORD, too_soon)
            .unwrap_err()
            .starts_with("the next password attempt"));
        assert_eq!(state(&lock), LockState::Locked);

        lock.unlock(PASSWORD, start + WRONG_PASSWORD_DELAY).unwrap();
        assert_eq!(state(&lock), LockState::Unlocked);
    }

    #[test]
    fn changing_the_password_needs_the_current_one() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let start = Instant::now();
        let hash = stored_hash(&lock);

        let error = lock
            .change_password(OTHER_PASSWORD, OTHER_PASSWORD, OTHER_PASSWORD, start)
            .unwrap_err();
        assert!(error.starts_with(WRONG_PASSWORD_ERROR), "{error}");
        assert_eq!(stored_hash(&lock), hash);

        let later = start + WRONG_PASSWORD_DELAY;
        lock.change_password(PASSWORD, OTHER_PASSWORD, OTHER_PASSWORD, later)
            .unwrap();

        assert!(lock
            .unlock(PASSWORD, later)
            .unwrap_err()
            .starts_with(WRONG_PASSWORD_ERROR));
        lock.unlock(OTHER_PASSWORD, later + WRONG_PASSWORD_DELAY)
            .unwrap();
        assert_eq!(state(&lock), LockState::Unlocked);
    }

    #[test]
    fn removing_the_password_needs_the_current_one() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let start = Instant::now();

        let error = lock.remove_password(OTHER_PASSWORD, start).unwrap_err();
        assert!(error.starts_with(WRONG_PASSWORD_ERROR), "{error}");
        assert!(stored_hash(&lock).is_some());

        lock.remove_password(PASSWORD, start + WRONG_PASSWORD_DELAY)
            .unwrap();

        assert_eq!(stored_hash(&lock), None);
        assert_eq!(state(&lock), LockState::NoPassword);
        assert_eq!(
            lock.load_settings().unwrap().settings.library_roots,
            vec![PathBuf::from("/srv/dcp")]
        );
    }

    #[test]
    fn saving_is_refused_while_locked_and_the_file_is_left_alone() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let before = std::fs::read_to_string(&lock.path).unwrap();

        let error = lock.save_settings(Settings::default()).unwrap_err();

        assert_eq!(error, LOCKED_ERROR);
        assert_eq!(std::fs::read_to_string(&lock.path).unwrap(), before);
    }

    #[test]
    fn the_hash_never_reaches_the_page() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let hash = stored_hash(&lock).unwrap();

        for unlocked in [false, true] {
            if unlocked {
                lock.unlock(PASSWORD, Instant::now()).unwrap();
            }
            let page_json = serde_json::to_string(&lock.load_settings().unwrap()).unwrap();
            assert!(!page_json.contains(&hash), "{page_json}");
            assert!(!page_json.contains("argon2"), "{page_json}");
            assert!(!page_json.contains("settingsPasswordHash"), "{page_json}");
        }
    }

    #[test]
    fn a_save_from_the_page_keeps_the_stored_hash_whatever_it_sends() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);
        let hash = stored_hash(&lock);
        lock.unlock(PASSWORD, Instant::now()).unwrap();
        let page_sends = [
            r#"{"libraryRoots": ["/mnt/ingest"], "settingsPasswordHash": "$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2g"}"#,
            r#"{"libraryRoots": ["/mnt/ingest"], "settingsPasswordHash": null}"#,
            r#"{"libraryRoots": ["/mnt/ingest"]}"#,
        ];

        for page_json in page_sends {
            let settings: Settings = serde_json::from_str(page_json).unwrap();
            lock.save_settings(settings).unwrap();

            assert_eq!(stored_hash(&lock), hash, "{page_json}");
            assert_eq!(
                lock.load_settings().unwrap().settings.library_roots,
                vec![PathBuf::from("/mnt/ingest")]
            );
        }
    }

    #[test]
    fn a_settings_file_written_before_the_lock_loads_without_a_password() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE);
        std::fs::write(&path, r#"{"libraryRoots": ["/srv/dcp"], "gpu": true}"#).unwrap();
        let lock = SettingsLock::new(path);

        assert_eq!(state(&lock), LockState::NoPassword);
        lock.refuse_while_locked().unwrap();
        lock.save_settings(Settings::default()).unwrap();
    }

    fn written_profile(profile: &lcms2::Profile, directory: &tempfile::TempDir) -> PathBuf {
        let path = directory.path().join("monitor.icc");
        std::fs::write(&path, profile.icc().unwrap()).unwrap();
        path
    }

    fn with_display_profile(profile: &Path) -> Settings {
        Settings {
            player_display_profile: Some(profile.to_path_buf()),
            ..Default::default()
        }
    }

    #[test]
    fn a_monitor_profile_the_player_takes_is_saved() {
        let directory = tempfile::tempdir().unwrap();
        let profile = written_profile(&lcms2::Profile::new_srgb(), &directory);
        let lock = SettingsLock::new(directory.path().join(SETTINGS_FILE));

        lock.save_settings(with_display_profile(&profile)).unwrap();

        assert_eq!(
            lock.load_settings()
                .unwrap()
                .settings
                .player_display_profile,
            Some(profile)
        );
    }

    #[test]
    fn a_monitor_profile_the_player_refuses_is_not_saved_and_the_error_names_it() {
        let directory = tempfile::tempdir().unwrap();
        let garbage = directory.path().join("garbage.icc");
        std::fs::write(&garbage, b"not an icc profile").unwrap();
        let lock = SettingsLock::new(directory.path().join(SETTINGS_FILE));

        let error = lock
            .save_settings(with_display_profile(&garbage))
            .unwrap_err();

        assert!(error.contains(&garbage.display().to_string()), "{error}");
        assert!(!lock.path.exists());
    }

    #[test]
    fn a_monitor_profile_change_is_refused_while_locked() {
        let directory = tempfile::tempdir().unwrap();
        let profile = written_profile(&lcms2::Profile::new_srgb(), &directory);
        let lock = locked_settings(&directory);
        let before = std::fs::read_to_string(&lock.path).unwrap();

        let error = lock
            .save_settings(with_display_profile(&profile))
            .unwrap_err();

        assert_eq!(error, LOCKED_ERROR);
        assert_eq!(std::fs::read_to_string(&lock.path).unwrap(), before);
    }

    #[test]
    fn turning_the_hdcp_requirement_off_is_refused_while_locked() {
        let directory = tempfile::tempdir().unwrap();
        let lock = SettingsLock::new(directory.path().join(SETTINGS_FILE));
        lock.save_settings(Settings {
            require_hdcp: true,
            ..Default::default()
        })
        .unwrap();
        lock.set_password(PASSWORD, PASSWORD).unwrap();

        let error = lock.save_settings(Settings::default()).unwrap_err();

        assert_eq!(error, LOCKED_ERROR);
        assert!(lock.load_settings().unwrap().settings.require_hdcp);
    }

    #[test]
    fn a_3d_output_change_is_refused_while_locked() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);

        let error = lock
            .save_settings(Settings {
                player_stereo: guikit::preview::player_controls::StereoMode::TopAndBottom,
                ..Default::default()
            })
            .unwrap_err();

        assert_eq!(error, LOCKED_ERROR);
        assert_eq!(
            lock.load_settings().unwrap().settings.player_stereo,
            guikit::preview::player_controls::StereoMode::LeftEye
        );
    }

    #[test]
    fn a_decode_resolution_change_is_refused_while_locked() {
        let directory = tempfile::tempdir().unwrap();
        let lock = locked_settings(&directory);

        let error = lock
            .save_settings(Settings {
                decode_resolution: crate::settings::DecodeResolution::Quarter,
                ..Default::default()
            })
            .unwrap_err();

        assert_eq!(error, LOCKED_ERROR);
        assert_eq!(
            lock.load_settings().unwrap().settings.decode_resolution,
            crate::settings::DecodeResolution::Automatic
        );
    }
}

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const SETTINGS_FILE: &str = "settings.json";

pub fn settings_path() -> PathBuf {
    postkit::preferences::config_dir(crate::APP_DIRECTORY_NAME).join(SETTINGS_FILE)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub library_roots: Vec<PathBuf>,
    pub recipient_certificate: Option<PathBuf>,
    pub recipient_key: Option<PathBuf>,
    pub gpu: bool,
    pub gpu_license: Option<String>,
    pub gpu_registration_url: Option<String>,
    // None plays on the monitor the main window is on
    pub player_monitor: Option<String>,
    pub player_fullscreen: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            library_roots: Vec::new(),
            recipient_certificate: None,
            recipient_key: None,
            gpu: false,
            gpu_license: None,
            gpu_registration_url: None,
            player_monitor: None,
            player_fullscreen: true,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Result<Settings, String> {
        let text = postkit::preferences::read_preferences_file(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let Some(text) = text else {
            return Ok(Settings::default());
        };
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.recipient_subject_name()?;
        let json = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        postkit::preferences::write_preferences_file(path, &json)
            .map_err(|error| format!("{}: {error}", path.display()))
    }

    pub fn recipient_subject_name(&self) -> Result<Option<String>, String> {
        self.recipient_certificate
            .as_deref()
            .map(postkit::kdm_store::recipient_subject_name)
            .transpose()
    }
}

#[tauri::command(async)]
pub fn load_settings() -> Result<Settings, String> {
    Settings::load(&settings_path())
}

#[tauri::command(async)]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    settings.save(&settings_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::recipient_chain;

    #[test]
    fn settings_round_trip_with_a_certificate_that_reads() {
        let directory = tempfile::tempdir().unwrap();
        let chain = recipient_chain();
        let path = directory.path().join("config").join(SETTINGS_FILE);
        let settings = Settings {
            library_roots: vec![PathBuf::from("/srv/dcp")],
            recipient_certificate: Some(chain.certificate.clone()),
            recipient_key: Some(chain.key.clone()),
            gpu: true,
            gpu_license: Some("licence-token".to_string()),
            gpu_registration_url: Some("https://licence.example/register".to_string()),
            player_monitor: Some("HDMI-1".to_string()),
            player_fullscreen: false,
        };

        settings.save(&path).unwrap();

        assert_eq!(Settings::load(&path).unwrap(), settings);
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["libraryRoots"], serde_json::json!(["/srv/dcp"]));
        assert_eq!(
            json["recipientCertificate"],
            serde_json::json!(chain.certificate.display().to_string())
        );
        assert_eq!(json["gpu"], serde_json::json!(true));
        assert_eq!(json["gpuLicense"], serde_json::json!("licence-token"));
        assert_eq!(
            json["gpuRegistrationUrl"],
            serde_json::json!("https://licence.example/register")
        );
        assert_eq!(json["playerMonitor"], serde_json::json!("HDMI-1"));
        assert_eq!(json["playerFullscreen"], serde_json::json!(false));
    }

    #[test]
    fn a_settings_file_written_before_the_gpu_fields_loads_with_the_gpu_off() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE);
        std::fs::write(&path, r#"{"libraryRoots": ["/srv/dcp"]}"#).unwrap();

        let settings = Settings::load(&path).unwrap();

        assert_eq!(settings.library_roots, vec![PathBuf::from("/srv/dcp")]);
        assert!(!settings.gpu);
        assert_eq!(settings.gpu_license, None);
        assert_eq!(settings.gpu_registration_url, None);
    }

    #[test]
    fn a_settings_file_written_before_the_player_fields_plays_full_screen_on_the_main_monitor() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE);
        std::fs::write(&path, r#"{"libraryRoots": ["/srv/dcp"], "gpu": true}"#).unwrap();

        let settings = Settings::load(&path).unwrap();

        assert_eq!(settings.player_monitor, None);
        assert!(settings.player_fullscreen);
    }

    #[test]
    fn a_certificate_that_is_not_pem_is_refused_and_nothing_is_written() {
        let directory = tempfile::tempdir().unwrap();
        let certificate = directory.path().join("recipient.pem");
        std::fs::write(&certificate, "not a certificate").unwrap();
        let path = directory.path().join(SETTINGS_FILE);
        let settings = Settings {
            recipient_certificate: Some(certificate.clone()),
            ..Default::default()
        };

        let error = settings.save(&path).unwrap_err();

        assert!(
            error.starts_with(&format!(
                "certificate {} is not valid PEM",
                certificate.display()
            )),
            "{error}"
        );
        assert!(!path.exists());
    }

    #[test]
    fn a_missing_settings_file_is_the_default() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            Settings::load(&directory.path().join(SETTINGS_FILE)).unwrap(),
            Settings::default()
        );
    }
}

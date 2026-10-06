use crate::settings_lock::{LockState, SettingsLock};
use guikit::preview::player_controls::{
    PictureControls, SoundControls, StereoMode, SubtitleControls,
};
use postkit::colour::{RenderingIntent, XyzToIcc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const SETTINGS_FILE: &str = "settings.json";

pub fn settings_path() -> PathBuf {
    postkit::preferences::config_dir(crate::APP_DIRECTORY_NAME).join(SETTINGS_FILE)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub library_roots: Vec<PathBuf>,
    pub recipient_certificate: Option<PathBuf>,
    pub recipient_key: Option<PathBuf>,
    pub gpu: bool,
    pub gpu_license: Option<String>,
    pub gpu_registration_url: Option<String>,
    // where the player goes full screen, None is the monitor the main window is on
    pub player_monitor: Option<String>,
    pub player_picture: PictureControls,
    pub player_sound: SoundControls,
    pub player_subtitles: SubtitleControls,
    pub player_stereo: StereoMode,
    pub decode_resolution: DecodeResolution,
    // a monitor ICC profile for DCP pictures, None is the built-in sRGB
    pub player_display_profile: Option<PathBuf>,
    // encrypted content plays only on an output whose HDCP reads Enabled
    pub require_hdcp: bool,
}

impl Settings {
    pub fn load(path: &Path) -> Result<Settings, String> {
        Ok(SettingsFile::load(path)?.settings)
    }

    pub fn check_display_profile(&self) -> Result<(), String> {
        self.player_display_profile
            .as_deref()
            .map_or(Ok(()), check_display_profile)
    }

    pub fn recipient_subject_name(&self) -> Result<Option<String>, String> {
        self.recipient_certificate
            .as_deref()
            .map(postkit::kdm_store::recipient_subject_name)
            .transpose()
    }
}

// automatic lets the player page step the decode scale to keep the frame rate
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecodeResolution {
    #[default]
    Automatic,
    Full,
    Half,
    Quarter,
}

// the page never sees this, it gets and sends Settings only
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    #[serde(flatten)]
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_password_hash: Option<String>,
}

impl SettingsFile {
    pub fn load(path: &Path) -> Result<SettingsFile, String> {
        let text = postkit::preferences::read_preferences_file(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let Some(text) = text else {
            return Ok(SettingsFile::default());
        };
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        postkit::preferences::write_preferences_file(path, &json)
            .map_err(|error| format!("{}: {error}", path.display()))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSettings {
    #[serde(flatten)]
    pub settings: Settings,
    pub settings_lock: LockState,
}

// the same check the player makes, so a profile it would refuse is never stored
pub fn check_display_profile(profile: &Path) -> Result<(), String> {
    XyzToIcc::new(profile, RenderingIntent::default()).map(|_| ())
}

#[tauri::command(async)]
pub fn settings_check_display_profile(profile: PathBuf) -> Result<(), String> {
    check_display_profile(&profile)
}

#[tauri::command(async)]
pub fn load_settings(lock: tauri::State<'_, SettingsLock>) -> Result<LoadedSettings, String> {
    lock.load_settings()
}

#[tauri::command(async)]
pub fn save_settings(
    settings: Settings,
    lock: tauri::State<'_, SettingsLock>,
) -> Result<(), String> {
    lock.save_settings(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::recipient_chain;
    use guikit::preview::player_controls::{MaskPercents, Scaling, SoundLayout};

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
            player_picture: PictureControls {
                brightness: 1.25,
                masks_percent: MaskPercents {
                    top: 5.0,
                    bottom: 5.0,
                    left: 0.0,
                    right: 2.5,
                },
                scaling: Scaling::Fill,
            },
            player_sound: SoundControls {
                device: Some("HDA Intel PCH".to_string()),
                layout: SoundLayout::FivePointOne,
                delay_milliseconds: -40,
            },
            player_subtitles: SubtitleControls {
                offset_percent: 4.0,
                colour: Some("#ffcc00".to_string()),
            },
            player_stereo: StereoMode::SideBySide,
            decode_resolution: DecodeResolution::Half,
            player_display_profile: Some(PathBuf::from("/usr/share/color/icc/booth.icc")),
            require_hdcp: true,
        };

        SettingsFile {
            settings: settings.clone(),
            ..Default::default()
        }
        .save(&path)
        .unwrap();

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
        assert_eq!(json["playerPicture"]["brightness"], serde_json::json!(1.25));
        assert_eq!(json["playerPicture"]["scaling"], serde_json::json!("fill"));
        assert_eq!(
            json["playerSound"]["layout"],
            serde_json::json!("fivePointOne")
        );
        assert_eq!(
            json["playerSound"]["delayMilliseconds"],
            serde_json::json!(-40)
        );
        assert_eq!(
            json["playerSubtitles"]["colour"],
            serde_json::json!("#ffcc00")
        );
        assert_eq!(json["requireHdcp"], serde_json::json!(true));
        assert_eq!(json["playerStereo"], serde_json::json!("sideBySide"));
        assert_eq!(json["decodeResolution"], serde_json::json!("half"));
        assert_eq!(
            json["playerDisplayProfile"],
            serde_json::json!("/usr/share/color/icc/booth.icc")
        );
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
    fn a_settings_file_written_before_the_player_fields_loads_with_the_player_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE);
        std::fs::write(&path, r#"{"libraryRoots": ["/srv/dcp"], "gpu": true}"#).unwrap();

        let settings = Settings::load(&path).unwrap();

        assert_eq!(settings.player_monitor, None);
        assert_eq!(settings.player_picture.brightness, 1.0);
        assert_eq!(
            settings.player_picture.masks_percent,
            MaskPercents::default()
        );
        assert_eq!(settings.player_sound, SoundControls::default());
        assert_eq!(settings.player_subtitles, SubtitleControls::default());
        assert_eq!(settings.player_display_profile, None);
        assert!(!settings.require_hdcp);
        assert_eq!(settings.player_stereo, StereoMode::LeftEye);
        assert_eq!(settings.decode_resolution, DecodeResolution::Automatic);
    }

    #[test]
    fn a_settings_file_with_the_dropped_player_fullscreen_field_still_loads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE);
        std::fs::write(
            &path,
            r#"{"libraryRoots": ["/srv/dcp"], "playerMonitor": "HDMI-1", "playerFullscreen": false}"#,
        )
        .unwrap();

        let settings = Settings::load(&path).unwrap();

        assert_eq!(settings.library_roots, vec![PathBuf::from("/srv/dcp")]);
        assert_eq!(settings.player_monitor.as_deref(), Some("HDMI-1"));
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

        let error = SettingsLock::new(path.clone())
            .save_settings(settings)
            .unwrap_err();

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

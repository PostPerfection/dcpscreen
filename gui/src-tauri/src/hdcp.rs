use crate::play::PlaySource;
use crate::settings::{settings_path, Settings};
#[cfg(target_os = "linux")]
use postkit::output_protection::drm_outputs;
#[cfg(windows)]
use postkit::output_protection::opm_outputs;
use postkit::output_protection::Verdict;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

const RECHECK_INTERVAL: Duration = Duration::from_secs(2);
// the main page stops playback and says why when it hears this
const HDCP_STOPPED_EVENT: &str = "hdcp-stopped";

// the CPL paths that played with content keys, which the recheck guards
#[derive(Default)]
pub struct EncryptedSources(Mutex<HashSet<String>>);

impl EncryptedSources {
    fn contains(&self, source: &str) -> bool {
        self.0.lock().unwrap().contains(source)
    }

    fn insert(&self, source: String) {
        self.0.lock().unwrap().insert(source);
    }
}

// the OPM sessions of the player window's monitor, kept open between rechecks
#[cfg(windows)]
#[derive(Default)]
pub struct OpmSessions(Mutex<opm_outputs::OpmSessions>);

pub fn supported() -> bool {
    cfg!(any(target_os = "linux", windows))
}

#[tauri::command]
pub fn hdcp_supported() -> bool {
    supported()
}

#[cfg(target_os = "linux")]
fn player_output_reading(app: &tauri::AppHandle) -> drm_outputs::OutputReading {
    let monitor = app
        .get_window(crate::PLAYER_WINDOW_LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())
        .and_then(|monitor| monitor.name().cloned());
    let Some(monitor) = monitor else {
        return drm_outputs::OutputReading::NotFound { monitor: None };
    };
    drm_outputs::reading_for_monitor(&monitor)
}

#[cfg(target_os = "linux")]
fn output_verdict(app: &tauri::AppHandle, settings: &Settings, encrypted: bool) -> Verdict {
    drm_outputs::verdict(settings.require_hdcp, encrypted, || {
        player_output_reading(app)
    })
}

#[cfg(windows)]
fn player_monitor(
    app: &tauri::AppHandle,
) -> Option<(windows::Win32::Graphics::Gdi::HMONITOR, String)> {
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    let window = app.get_window(crate::PLAYER_WINDOW_LABEL)?;
    let window_handle = window.hwnd().ok()?;
    let name = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned())
        .unwrap_or_else(|| "the player window's monitor".to_string());
    // SAFETY: MonitorFromWindow only reads the handle, which tauri keeps alive with the window
    let monitor = unsafe { MonitorFromWindow(window_handle, MONITOR_DEFAULTTONEAREST) };
    (!monitor.is_invalid()).then_some((monitor, name))
}

#[cfg(windows)]
fn output_verdict(app: &tauri::AppHandle, settings: &Settings, encrypted: bool) -> Verdict {
    opm_outputs::verdict(settings.require_hdcp, encrypted, || {
        let Some((monitor, name)) = player_monitor(app) else {
            return opm_outputs::MonitorReading::NotFound { monitor: None };
        };
        app.state::<OpmSessions>()
            .0
            .lock()
            .unwrap()
            .read(monitor, &name)
    })
}

// the setting never blocks playback where the output cannot be read
#[cfg(not(any(target_os = "linux", windows)))]
fn output_verdict(_app: &tauri::AppHandle, _settings: &Settings, _encrypted: bool) -> Verdict {
    Verdict::Play
}

// refuses an encrypted source the output may not show, and remembers it for the recheck
pub fn admit(
    app: &tauri::AppHandle,
    settings: &Settings,
    source: &PlaySource,
) -> Result<(), String> {
    let PlaySource::Ready {
        cpl_path,
        content_keys: Some(_),
        ..
    } = source
    else {
        return Ok(());
    };
    if let Verdict::Refuse(message) = output_verdict(app, settings, true) {
        return Err(message);
    }
    app.state::<EncryptedSources>()
        .insert(cpl_path.display().to_string());
    Ok(())
}

fn playing_source(app: &tauri::AppHandle) -> Option<String> {
    let metadata = guikit::preview::preview_get_metadata(app.state()).ok()?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata).ok()?;
    metadata["source"].as_str().map(str::to_string)
}

fn recheck(app: &tauri::AppHandle) -> Verdict {
    let Some(source) = playing_source(app) else {
        return Verdict::Play;
    };
    let settings = match Settings::load(&settings_path()) {
        Ok(settings) => settings,
        Err(error) => return Verdict::Refuse(format!("the settings do not read: {error}")),
    };
    let encrypted = app.state::<EncryptedSources>().contains(&source);
    output_verdict(app, &settings, encrypted)
}

fn stop_encrypted_playback(app: &tauri::AppHandle, message: String) {
    eprintln!("[hdcp] stopped: {message}");
    app.state::<guikit::preview::screening_runner::ScreeningRunner>()
        .stop();
    if let Err(error) = guikit::preview::preview_stop(app.state()) {
        eprintln!("[hdcp] the player did not stop: {error}");
    }
    app.emit_to(crate::MAIN_WINDOW_LABEL, HDCP_STOPPED_EVENT, message)
        .expect("the main window does not hear the HDCP stop");
}

pub fn start_recheck(app: tauri::AppHandle) {
    #[cfg(windows)]
    app.manage(OpmSessions::default());
    std::thread::spawn(move || loop {
        std::thread::sleep(RECHECK_INTERVAL);
        if let Verdict::Refuse(message) = recheck(&app) {
            stop_encrypted_playback(&app, message);
        }
    });
}

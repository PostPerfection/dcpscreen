#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};

const APP_DIRECTORY_NAME: &str = "dcpscreen";
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(target_os = "linux")]
const MAIN_WEBVIEW_LABEL: &str = "main-webview";
#[cfg(target_os = "linux")]
const MAIN_WINDOW_TITLE: &str = "DCP Screen";
#[cfg(target_os = "linux")]
const MAIN_WINDOW_WIDTH: f64 = 1100.0;
#[cfg(target_os = "linux")]
const MAIN_WINDOW_HEIGHT: f64 = 700.0;
#[cfg(target_os = "linux")]
const MAIN_WINDOW_MINIMUM_WIDTH: f64 = 700.0;
#[cfg(target_os = "linux")]
const MAIN_WINDOW_MINIMUM_HEIGHT: f64 = 500.0;
#[cfg(target_os = "linux")]
const WINDOW_BACKGROUND: tauri::window::Color = tauri::window::Color(0, 0, 0, 255);
const PLAYER_WINDOW_LABEL: &str = "player";
#[cfg(target_os = "linux")]
const PLAYER_WEBVIEW_LABEL: &str = "player-webview";
#[cfg(target_os = "linux")]
const PLAYER_PAGE: &str = "player.html";
#[cfg(target_os = "linux")]
const PLAYER_WINDOW_TITLE: &str = "DCP Screen Player";
#[cfg(target_os = "linux")]
const PLAYER_WINDOW_WIDTH: f64 = 1280.0;
#[cfg(target_os = "linux")]
const PLAYER_WINDOW_HEIGHT: f64 = 720.0;
#[cfg(target_os = "linux")]
const PLAYER_WINDOW_MINIMUM_WIDTH: f64 = 320.0;
#[cfg(target_os = "linux")]
const PLAYER_WINDOW_MINIMUM_HEIGHT: f64 = 180.0;
// the main page stops playback when it hears this
const PLAYER_CLOSE_REQUESTED_EVENT: &str = "player-close-requested";

mod display_profiles;
mod hdcp;
mod keys;
mod library;
mod play;
mod playlists;
mod settings;
mod settings_lock;
#[cfg(test)]
mod test_fixtures;
mod verify_jobs;

fn data_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .expect("no data directory, HOME is not set")
        .join(APP_DIRECTORY_NAME)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    guikit_startup::prefer_shared_memory_webkit_frames_on_nvidia();
    #[cfg(unix)]
    guikit_startup::fork_terminal_guard();
    postkit::grok_encoder::set_packaged_gpu_plugin_path(APP_DIRECTORY_NAME);

    let job_queue = verify_jobs::JobQueue::new(verify_jobs::jobs_path());
    job_queue.load_jobs_file();
    let library = library::LibraryState::load(library::library_path())
        .expect("the library file does not read");
    let settings = settings::Settings::load(&settings::settings_path())
        .expect("the settings file does not read");
    let summary = library
        .refresh(&settings.library_roots)
        .expect("the library file does not save");
    println!("[library] {summary}");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(job_queue)
        .manage(library)
        .manage(settings_lock::SettingsLock::new(settings::settings_path()))
        .invoke_handler(tauri::generate_handler![
            guikit::preview::preview_load,
            guikit::preview::preview_play_pause,
            guikit::preview::preview_seek,
            guikit::preview::preview_seek_absolute,
            guikit::preview::preview_frame_step,
            guikit::preview::preview_frame_back_step,
            guikit::preview::preview_stop,
            guikit::preview::preview_load_dcp,
            guikit::preview::preview_needs_content_keys,
            guikit::preview::preview_get_position,
            guikit::preview::preview_get_duration,
            guikit::preview::preview_get_metadata,
            guikit::preview::preview_set_surface,
            guikit::preview::preview_is_embedded,
            guikit::preview::preview_set_overlays,
            guikit::preview::preview_set_decode_scale,
            guikit::preview::preview_set_subtitle_file,
            guikit::preview::preview_set_subtitle_visibility,
            guikit::preview::player_controls::preview_set_picture,
            guikit::preview::player_controls::preview_set_sound_device,
            guikit::preview::player_controls::preview_set_sound_layout,
            guikit::preview::player_controls::preview_set_sound_delay,
            guikit::preview::player_controls::preview_set_subtitle_presentation,
            guikit::preview::player_controls::preview_sound_devices,
            guikit::preview::player_controls::preview_set_display_profile,
            guikit::preview::player_controls::preview_set_stereo_output,
            guikit::preview::player_controls::preview_stereo_output,
            display_profiles::display_profiles,
            hdcp::hdcp_supported,
            guikit::gpu::set_gpu,
            settings::load_settings,
            settings::save_settings,
            settings::settings_check_display_profile,
            settings_lock::settings_lock_set,
            settings_lock::settings_lock_change,
            settings_lock::settings_lock_remove,
            settings_lock::settings_unlock,
            settings_lock::settings_lock,
            library::library_list,
            library::library_refresh,
            library::library_verify,
            library::library_remove,
            play::library_play,
            playlists::playlist_list,
            playlists::playlist_open,
            playlists::playlist_save,
            playlists::playlist_plan,
            playlists::playlist_play,
            playlists::playlist_stop,
            playlists::playlist_state,
            keys::keys_list,
            keys::keys_ingest,
            keys::keys_remove,
            verify_jobs::list_jobs,
            verify_jobs::cancel_job,
            verify_jobs::move_job,
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            guikit::startup::create_main_window(
                app,
                &guikit::startup::MainWindow {
                    label: MAIN_WINDOW_LABEL,
                    webview_label: MAIN_WEBVIEW_LABEL,
                    title: MAIN_WINDOW_TITLE,
                    width: MAIN_WINDOW_WIDTH,
                    height: MAIN_WINDOW_HEIGHT,
                    minimum_width: MAIN_WINDOW_MINIMUM_WIDTH,
                    minimum_height: MAIN_WINDOW_MINIMUM_HEIGHT,
                    background: WINDOW_BACKGROUND,
                },
            )?;
            #[cfg(target_os = "linux")]
            guikit::startup::create_player_window(
                app,
                &guikit::startup::MainWindow {
                    label: PLAYER_WINDOW_LABEL,
                    webview_label: PLAYER_WEBVIEW_LABEL,
                    title: PLAYER_WINDOW_TITLE,
                    width: PLAYER_WINDOW_WIDTH,
                    height: PLAYER_WINDOW_HEIGHT,
                    minimum_width: PLAYER_WINDOW_MINIMUM_WIDTH,
                    minimum_height: PLAYER_WINDOW_MINIMUM_HEIGHT,
                    background: WINDOW_BACKGROUND,
                },
                PLAYER_PAGE,
            )?;
            #[cfg(target_os = "linux")]
            app.manage(guikit::preview::create_player_under_page(
                app,
                PLAYER_WINDOW_LABEL,
            ));
            #[cfg(not(target_os = "linux"))]
            app.manage(guikit::preview::create_player(app, PLAYER_WINDOW_LABEL));
            app.manage(guikit::preview::screening_runner::ScreeningRunner::new(
                app.handle().clone(),
            ));
            app.manage(verify_jobs::start_worker(app.handle().clone()));
            app.manage(hdcp::EncryptedSources::default());
            hdcp::start_recheck(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // the player window holds the video surface
            (PLAYER_WINDOW_LABEL, tauri::WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                window.hide().expect("the player window does not hide");
                window
                    .emit_to(MAIN_WINDOW_LABEL, PLAYER_CLOSE_REQUESTED_EVENT, ())
                    .expect("the main window does not hear the player close");
            }
            // the hidden player window would keep the app running
            (MAIN_WINDOW_LABEL, tauri::WindowEvent::Destroyed) => window.app_handle().exit(0),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app.state::<guikit::preview::PreviewPlayer>().shutdown();
                app.state::<verify_jobs::JobQueue>().stop_for_exit();
            }
        });
}

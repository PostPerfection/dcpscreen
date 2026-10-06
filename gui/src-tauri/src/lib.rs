#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

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
const MAIN_WINDOW_BACKGROUND: tauri::window::Color = tauri::window::Color(0, 0, 0, 255);

mod keys;
mod library;
mod play;
mod settings;
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
            guikit::gpu::set_gpu,
            settings::load_settings,
            settings::save_settings,
            library::library_list,
            library::library_refresh,
            library::library_verify,
            library::library_remove,
            play::library_play,
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
                    background: MAIN_WINDOW_BACKGROUND,
                },
            )?;
            app.manage(guikit::preview::create_player(app, MAIN_WINDOW_LABEL));
            app.manage(verify_jobs::start_worker(app.handle().clone()));
            Ok(())
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

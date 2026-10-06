use std::path::PathBuf;

// colord matches the model the monitor's EDID gives, which is also the name tauri gives the monitor
#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn display_profiles(monitor: String) -> Result<Vec<PathBuf>, String> {
    colord::profiles_for_model(&monitor)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn display_profiles(_monitor: String) -> Result<Vec<PathBuf>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "linux")]
mod colord {
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;
    use std::path::PathBuf;
    use std::time::Duration;

    const SERVICE: &str = "org.freedesktop.ColorManager";
    const MANAGER_PATH: &str = "/org/freedesktop/ColorManager";
    const DEVICE_INTERFACE: &str = "org.freedesktop.ColorManager.Device";
    const PROFILE_INTERFACE: &str = "org.freedesktop.ColorManager.Profile";
    const DEVICES_BY_KIND_METHOD: &str = "GetDevicesByKind";
    const DISPLAY_KIND: &str = "display";
    const MODEL_PROPERTY: &str = "Model";
    const PROFILES_PROPERTY: &str = "Profiles";
    const FILENAME_PROPERTY: &str = "Filename";
    const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

    fn colord_error(error: dbus::Error) -> String {
        format!("colord: {error}")
    }

    pub fn profiles_for_model(model: &str) -> Result<Vec<PathBuf>, String> {
        let connection = Connection::new_system().map_err(colord_error)?;
        let manager = connection.with_proxy(SERVICE, MANAGER_PATH, REPLY_TIMEOUT);
        let (devices,): (Vec<dbus::Path<'static>>,) = manager
            .method_call(SERVICE, DEVICES_BY_KIND_METHOD, (DISPLAY_KIND,))
            .map_err(colord_error)?;
        let mut profiles = Vec::new();
        for device in devices {
            let device = connection.with_proxy(SERVICE, device, REPLY_TIMEOUT);
            let device_model: String = device
                .get(DEVICE_INTERFACE, MODEL_PROPERTY)
                .map_err(colord_error)?;
            if device_model != model {
                continue;
            }
            let device_profiles: Vec<dbus::Path<'static>> = device
                .get(DEVICE_INTERFACE, PROFILES_PROPERTY)
                .map_err(colord_error)?;
            for profile in device_profiles {
                let filename: String = connection
                    .with_proxy(SERVICE, profile, REPLY_TIMEOUT)
                    .get(PROFILE_INTERFACE, FILENAME_PROPERTY)
                    .map_err(colord_error)?;
                profiles.push(PathBuf::from(filename));
            }
        }
        Ok(profiles)
    }
}

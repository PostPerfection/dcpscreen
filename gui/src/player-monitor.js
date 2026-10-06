import { withSavedChoice } from "./saved-choices.js";

// the saved monitor while it is connected, otherwise the one the main window is on
export function fullscreenMonitor(monitors, savedName, mainWindowMonitor) {
  const saved = monitors.find((monitor) => monitor.name !== null && monitor.name === savedName);
  return saved ?? mainWindowMonitor ?? monitors[0];
}

// a monitor with no name cannot be saved, so it is not offered
export function playerMonitorChoices(monitors, savedName) {
  const connected = monitors
    .filter((monitor) => monitor.name !== null)
    .map((monitor) => ({ name: monitor.name, label: `${monitor.name} (${monitor.size.width}x${monitor.size.height})` }));
  return withSavedChoice(connected, savedName);
}

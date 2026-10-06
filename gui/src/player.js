import { getCurrentWindow } from "@tauri-apps/api/window";
import { initFullPageSurface, previewPlayPause } from "../../extern/guikit/src/preview.js";

const LEAVE_FULLSCREEN_KEY = "Escape";
const PLAY_PAUSE_KEY = " ";

function leaveFullscreen() {
  getCurrentWindow()
    .setFullscreen(false)
    .catch((error) => console.error("[player] Failed to leave full screen:", error));
}

window.addEventListener("keydown", (event) => {
  if (event.key === LEAVE_FULLSCREEN_KEY) leaveFullscreen();
  if (event.key !== PLAY_PAUSE_KEY) return;
  event.preventDefault();
  previewPlayPause();
});
window.addEventListener("dblclick", leaveFullscreen);

initFullPageSurface();

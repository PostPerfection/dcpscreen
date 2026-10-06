import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import {
  initFullPageSurface,
  initLiveTransport,
  previewPlayPause,
  watchPreviewMetadata,
} from "../../extern/guikit/src/preview.js";
import { fullscreenMonitor } from "./player-monitor.js";

const MAIN_WINDOW_LABEL = "main";
const HUD_IDLE_TIMEOUT_MS = 3000;
const HUD_SHOWN_CLASS = "player-hud-shown";
const LEAVE_FULLSCREEN_KEY = "Escape";
const PLAY_PAUSE_KEY = " ";
const FULLSCREEN_TOGGLE_KEYS = ["f", "F"];

const playerWindow = getCurrentWindow();
const hud = document.getElementById("player-hud");
const hint = document.getElementById("player-hint");
let paused = false;
let pointerOverHud = false;
let hideTimer = null;

function reportFailure(error) {
  console.error("[player]", error);
}

function showHud() {
  hud.classList.add(HUD_SHOWN_CLASS);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideHudUnlessHeld, HUD_IDLE_TIMEOUT_MS);
}

function hideHudUnlessHeld() {
  hint.hidden = true;
  if (paused || pointerOverHud) return;
  hud.classList.remove(HUD_SHOWN_CLASS);
}

// currentMonitor() from the window module only answers for the calling window
function mainWindowMonitor() {
  return invoke("plugin:window|current_monitor", { label: MAIN_WINDOW_LABEL });
}

async function enterFullscreen() {
  const settings = await invoke("load_settings");
  const monitor = fullscreenMonitor(await availableMonitors(), settings.playerMonitor, await mainWindowMonitor());
  await playerWindow.setFullscreenOnMonitor(monitor.position);
  hint.hidden = false;
  showHud();
}

function leaveFullscreen() {
  playerWindow.setFullscreen(false).catch(reportFailure);
}

async function toggleFullscreen() {
  if (await playerWindow.isFullscreen()) await playerWindow.setFullscreen(false);
  else await enterFullscreen();
}

window.addEventListener("keydown", (event) => {
  if (event.key === PLAY_PAUSE_KEY) {
    event.preventDefault();
    previewPlayPause();
    return;
  }
  if (event.key === LEAVE_FULLSCREEN_KEY) {
    leaveFullscreen();
    return;
  }
  showHud();
  if (FULLSCREEN_TOGGLE_KEYS.includes(event.key)) toggleFullscreen().catch(reportFailure);
});
window.addEventListener("mousemove", showHud);
window.addEventListener("dblclick", (event) => {
  if (hud.contains(event.target)) return;
  toggleFullscreen().catch(reportFailure);
});
hud.addEventListener("mouseenter", () => {
  pointerOverHud = true;
});
hud.addEventListener("mouseleave", () => {
  pointerOverHud = false;
  showHud();
});
watchPreviewMetadata((meta) => {
  const nowPaused = Boolean(meta.paused);
  if (nowPaused === paused) return;
  paused = nowPaused;
  showHud();
});
document.getElementById("player-stop-btn").addEventListener("click", () => playerWindow.close().catch(reportFailure));
document
  .getElementById("player-fullscreen-btn")
  .addEventListener("click", () => toggleFullscreen().catch(reportFailure));

initFullPageSurface();
initLiveTransport();

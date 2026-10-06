import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import {
  initFullPageSurface,
  initLiveTransport,
  previewPlayPause,
  watchPreviewMetadata,
} from "../../extern/guikit/src/preview.js";
import { fullscreenMonitor } from "./player-monitor.js";
import { holdCountdownText, playlistHudText } from "./screening-playlist.js";
import { nextStereoMode, stereoHudText } from "./stereo-output.js";

const MAIN_WINDOW_LABEL = "main";
const HUD_IDLE_TIMEOUT_MS = 3000;
const HUD_SHOWN_CLASS = "player-hud-shown";
const CURSOR_HIDDEN_CLASS = "player-cursor-hidden";
const LEAVE_FULLSCREEN_KEY = "Escape";
const PLAY_PAUSE_KEY = " ";
const FULLSCREEN_TOGGLE_KEYS = ["f", "F"];
const PLAYLIST_POLL_INTERVAL_MS = 500;
const HOLDING_ACTIVITY = "holding";
// hides the transport of the composition that played before the hold
const HOLDING_CLASS = "player-holding";

const playerWindow = getCurrentWindow();
const hud = document.getElementById("player-hud");
const hint = document.getElementById("player-hint");
const hold = document.getElementById("player-hold");
const holdStill = document.getElementById("player-hold-still");
const playlistRow = document.getElementById("player-row");
const playlistRowCurrent = document.getElementById("player-row-current");
const playlistRowNext = document.getElementById("player-row-next");
const holdCountdown = document.getElementById("player-hold-countdown");
const stereoButton = document.getElementById("player-stereo-btn");
let paused = false;
// in page coordinates, null once a resize has moved the page under the pointer
let lastPointer = null;
let hideTimer = null;

function reportFailure(error) {
  console.error("[player]", error);
}

function showHud() {
  hud.classList.add(HUD_SHOWN_CLASS);
  document.body.classList.remove(CURSOR_HIDDEN_CLASS);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideHudUnlessHeld, HUD_IDLE_TIMEOUT_MS);
}

function pointerIsOverHud() {
  if (!lastPointer) return false;
  const box = hud.getBoundingClientRect();
  const insideHorizontally = lastPointer.x >= box.left && lastPointer.x <= box.right;
  return insideHorizontally && lastPointer.y >= box.top && lastPointer.y <= box.bottom;
}

function hideHudUnlessHeld() {
  hint.hidden = true;
  if (paused || pointerIsOverHud()) {
    hideTimer = setTimeout(hideHudUnlessHeld, HUD_IDLE_TIMEOUT_MS);
    return;
  }
  hud.classList.remove(HUD_SHOWN_CLASS);
  playerWindow
    .isFullscreen()
    .then((fullscreen) => {
      const hudHidden = !hud.classList.contains(HUD_SHOWN_CLASS);
      document.body.classList.toggle(CURSOR_HIDDEN_CLASS, fullscreen && hudHidden);
    })
    .catch(reportFailure);
}

// currentMonitor() from the window module only answers for the calling window
function mainWindowMonitor() {
  return invoke("plugin:window|current_monitor", { label: MAIN_WINDOW_LABEL });
}

async function enterFullscreen() {
  hint.hidden = false;
  showHud();
  const settings = await invoke("load_settings");
  const monitor = fullscreenMonitor(await availableMonitors(), settings.playerMonitor, await mainWindowMonitor());
  await playerWindow.setFullscreenOnMonitor(monitor.position);
}

async function leaveFullscreen() {
  hint.hidden = true;
  showHud();
  await playerWindow.setFullscreen(false);
}

async function toggleFullscreen() {
  if (await playerWindow.isFullscreen()) await leaveFullscreen();
  else await enterFullscreen();
}

window.addEventListener("keydown", (event) => {
  if (event.key === PLAY_PAUSE_KEY) {
    event.preventDefault();
    if (!document.body.classList.contains(HOLDING_CLASS)) previewPlayPause();
    return;
  }
  if (event.key === LEAVE_FULLSCREEN_KEY) {
    leaveFullscreen().catch(reportFailure);
    return;
  }
  showHud();
  if (FULLSCREEN_TOGGLE_KEYS.includes(event.key)) toggleFullscreen().catch(reportFailure);
});
window.addEventListener("mousemove", (event) => {
  lastPointer = { x: event.clientX, y: event.clientY };
  showHud();
});
window.addEventListener("resize", () => {
  lastPointer = null;
});
window.addEventListener("dblclick", (event) => {
  if (hud.contains(event.target)) return;
  toggleFullscreen().catch(reportFailure);
});
async function showStereoOutput(stereoscopic) {
  const mode = stereoscopic ? await invoke("preview_stereo_output") : null;
  const text = stereoHudText(stereoscopic, mode);
  stereoButton.hidden = !text;
  stereoButton.textContent = text ?? "";
}

stereoButton.addEventListener("click", () =>
  invoke("preview_stereo_output")
    .then((mode) => invoke("preview_set_stereo_output", { output: nextStereoMode(mode) }))
    .then(() => showStereoOutput(true))
    .catch(reportFailure));

watchPreviewMetadata((meta) => {
  showStereoOutput(Boolean(meta.stereoscopic)).catch(reportFailure);
  const nowPaused = Boolean(meta.paused);
  if (nowPaused === paused) return;
  paused = nowPaused;
  showHud();
});
document.getElementById("player-stop-btn").addEventListener("click", () => playerWindow.close().catch(reportFailure));
document
  .getElementById("player-fullscreen-btn")
  .addEventListener("click", () => toggleFullscreen().catch(reportFailure));

function showHold(stillImage) {
  hold.hidden = false;
  const source = stillImage ? convertFileSrc(stillImage) : "";
  if (holdStill.getAttribute("src") !== source) holdStill.setAttribute("src", source);
  holdStill.hidden = !stillImage;
}

async function showPlaylistState() {
  const state = await invoke("playlist_state");
  const holding = state?.activity === HOLDING_ACTIVITY;
  if (holding) showHold(state.stillImage);
  else hold.hidden = true;
  document.body.classList.toggle(HOLDING_CLASS, holding);
  holdCountdown.textContent = holdCountdownText(state) ?? "";
  const text = playlistHudText(state);
  playlistRow.hidden = !text;
  if (!text) return;
  playlistRowCurrent.textContent = text.current;
  playlistRowNext.textContent = text.next;
}

setInterval(() => showPlaylistState().catch(reportFailure), PLAYLIST_POLL_INTERVAL_MS);
initFullPageSurface();
initLiveTransport();

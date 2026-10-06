import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window, availableMonitors } from "@tauri-apps/api/window";
import { open, message } from "@tauri-apps/plugin-dialog";
import { initPreview, previewFile, stopPreview, watchPreviewMetadata } from "../../extern/guikit/src/preview.js";
import { initJobsPanel, refreshJobs, startJobsPolling, stopJobsPolling } from "../../extern/guikit/src/jobs.js";
import { initLibraryPanel, refreshLibrary } from "../../extern/guikit/src/library.js";
import { initKeysPanel, refreshKeys } from "../../extern/guikit/src/keys.js";
import { initGpuSettings, fillGpuSettings, gpuSettingsFromForm, uncheckGpu, applyGpuSetting } from "../../extern/guikit/src/gpu-settings.js";
import { settingsFromFields, withLibraryRoot, withoutLibraryRoot } from "./settings-form.js";
import { playRefusalText } from "./play-refusal.js";
import { playerMonitorChoices } from "./player-monitor.js";
import { playerControlCommands, playerControlsFromFields, playerWarningText, soundDeviceChoices } from "./player-controls.js";

const KDM_FILTERS = [{ name: "KDM", extensions: ["xml"] }];
const CERTIFICATE_FILTERS = [{ name: "Certificate", extensions: ["pem", "crt"] }];
const PRIVATE_KEY_FILTERS = [{ name: "Private key", extensions: ["pem", "key"] }];
const PLAY_SOURCE_READY = "ready";
const PLAY_REFUSAL_TITLE = "No KDM fits";
const SETTINGS_SAVED_STATUS = "Settings saved";
const GPU_UNAVAILABLE_STATUS = "GPU decoding unavailable";
const LIBRARY_POLL_INTERVAL_MS = 3000;
const REMOVE_ROOT_TEXT = "✕";
const PLAYER_WINDOW_LABEL = "player";
// the Rust side sends it when the window manager closes the player window
const PLAYER_CLOSE_REQUESTED_EVENT = "player-close-requested";
const MAIN_WINDOW_MONITOR_TEXT = "Same as the main window";
const DEFAULT_SOUND_DEVICE_TEXT = "Default";
const READY_STATUS = "Ready";
const BRIGHTNESS_DECIMALS = 2;
const DEFAULT_SUBTITLE_COLOUR = "#ffffff";

const certificateInput = document.getElementById("set-recipient-certificate");
const privateKeyInput = document.getElementById("set-recipient-key");
const libraryRootsList = document.getElementById("set-library-roots");
const playerMonitorSelect = document.getElementById("set-player-monitor");
const playerFields = {
  brightness: document.getElementById("set-player-brightness"),
  brightnessValue: document.getElementById("set-player-brightness-value"),
  maskTop: document.getElementById("set-player-mask-top"),
  maskBottom: document.getElementById("set-player-mask-bottom"),
  maskLeft: document.getElementById("set-player-mask-left"),
  maskRight: document.getElementById("set-player-mask-right"),
  scaling: document.getElementById("set-player-scaling"),
  soundDevice: document.getElementById("set-player-sound-device"),
  soundLayout: document.getElementById("set-player-sound-layout"),
  soundDelayMilliseconds: document.getElementById("set-player-sound-delay"),
  subtitleOffsetPercent: document.getElementById("set-player-subtitle-offset"),
  subtitleColourOverridden: document.getElementById("set-player-subtitle-colour-overridden"),
  subtitleColour: document.getElementById("set-player-subtitle-colour"),
};
const playerWindow = await Window.getByLabel(PLAYER_WINDOW_LABEL);
let libraryRoots = [];
let libraryPoll = null;
// what the player was last given, null before the first apply
let appliedPlayerControls = null;
// the warning line on the status bar, null while the player has none
let shownPlayerWarning = null;

function setStatus(text) {
  const el = document.getElementById("status-text");
  if (el) {
    el.textContent = text;
    el.title = text;
  }
}

function reportingErrors(action) {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      setStatus(String(error));
    }
  };
}

function startLibraryPolling() {
  stopLibraryPolling();
  libraryPoll = setInterval(refreshLibrary, LIBRARY_POLL_INTERVAL_MS);
}

function stopLibraryPolling() {
  clearInterval(libraryPoll);
  libraryPoll = null;
}

document.querySelectorAll(".sidebar-btn[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sidebar-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    const view = document.getElementById(`view-${btn.dataset.view}`);
    if (view) view.classList.add("active");
    if (btn.dataset.view === "keys") reportingErrors(refreshKeys)();
    if (btn.dataset.view === "settings") reportingErrors(showSettings)();
    if (btn.dataset.view === "library") {
      refreshLibrary();
      startLibraryPolling();
    } else {
      stopLibraryPolling();
    }
    if (btn.dataset.view === "jobs") {
      refreshJobs();
      startJobsPolling();
    } else {
      stopJobsPolling();
    }
  });
});

document.getElementById("theme-toggle")?.addEventListener("click", () => {
  document.body.classList.toggle("light");
  const btn = document.getElementById("theme-toggle");
  btn.textContent = document.body.classList.contains("light") ? "☀️" : "🌙";
});

initJobsPanel({
  tableBody: document.getElementById("jobs-tbody"),
  statusBadge: document.getElementById("jobs-status"),
  refreshButton: document.getElementById("jobs-refresh"),
});

async function refreshLibraryFromDisk() {
  setStatus(await invoke("library_refresh"));
  await refreshLibrary();
}

// a player hidden while full screen would come back full screen
async function showPlayerWindow() {
  await playerWindow.setFullscreen(false);
  await playerWindow.show();
  await playerWindow.setFocus();
}

async function stopPlayback() {
  stopPreview();
  await playerWindow.hide();
}

async function playComposition(libraryPackage, composition) {
  const source = await invoke("library_play", { directory: libraryPackage.directory, cplId: composition.id });
  if (source.kind !== PLAY_SOURCE_READY) {
    await message(playRefusalText(composition.title, source.kdms), { title: PLAY_REFUSAL_TITLE, kind: "warning" });
    return;
  }
  await showPlayerWindow();
  await previewFile(source.cplPath, source.contentKeys);
}

initLibraryPanel({
  tableBody: document.getElementById("library-tbody"),
  statusBadge: document.getElementById("library-status"),
  load: () => invoke("library_list"),
  actions: {
    play: reportingErrors(playComposition),
    verify: reportingErrors((libraryPackage) => invoke("library_verify", { directory: libraryPackage.directory })),
    remove: reportingErrors((libraryPackage) => invoke("library_remove", { directory: libraryPackage.directory })),
  },
});
document.getElementById("library-refresh").addEventListener("click", reportingErrors(refreshLibraryFromDisk));
document.getElementById("player-stop-btn").addEventListener("click", reportingErrors(stopPlayback));
listen(PLAYER_CLOSE_REQUESTED_EVENT, reportingErrors(stopPlayback));

async function ingestKdm() {
  const path = await open({ filters: KDM_FILTERS });
  if (path) await invoke("keys_ingest", { path });
}

initKeysPanel({
  tableBody: document.getElementById("keys-tbody"),
  statusBadge: document.getElementById("keys-status"),
  ingestButton: document.getElementById("keys-ingest"),
  load: () => invoke("keys_list"),
  actions: {
    ingest: reportingErrors(ingestKdm),
    remove: reportingErrors((kdm) => invoke("keys_remove", { path: kdm.path })),
  },
});

function renderLibraryRoots() {
  libraryRootsList.replaceChildren(...libraryRoots.map((root, index) => {
    const item = document.createElement("li");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-sm";
    remove.textContent = REMOVE_ROOT_TEXT;
    remove.addEventListener("click", () => {
      libraryRoots = withoutLibraryRoot(libraryRoots, index);
      renderLibraryRoots();
    });
    item.append(root, " ", remove);
    return item;
  }));
}

function choiceOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

async function fillPlayerSettings(settings) {
  const choices = playerMonitorChoices(await availableMonitors(), settings.playerMonitor);
  playerMonitorSelect.replaceChildren(
    choiceOption("", MAIN_WINDOW_MONITOR_TEXT),
    ...choices.map((choice) => choiceOption(choice.name, choice.label)),
  );
  playerMonitorSelect.value = settings.playerMonitor ?? "";
  await fillPlayerControls(settings);
}

function showBrightness() {
  playerFields.brightnessValue.value = Number(playerFields.brightness.value).toFixed(BRIGHTNESS_DECIMALS);
}

function enableSubtitleColour() {
  playerFields.subtitleColour.disabled = !playerFields.subtitleColourOverridden.checked;
}

async function fillPlayerControls({ playerPicture, playerSound, playerSubtitles }) {
  playerFields.brightness.value = playerPicture.brightness;
  showBrightness();
  playerFields.maskTop.value = playerPicture.masksPercent.top;
  playerFields.maskBottom.value = playerPicture.masksPercent.bottom;
  playerFields.maskLeft.value = playerPicture.masksPercent.left;
  playerFields.maskRight.value = playerPicture.masksPercent.right;
  playerFields.scaling.value = playerPicture.scaling;
  const devices = soundDeviceChoices(await invoke("preview_sound_devices"), playerSound.device);
  playerFields.soundDevice.replaceChildren(
    choiceOption("", DEFAULT_SOUND_DEVICE_TEXT),
    ...devices.map((device) => choiceOption(device.name, device.label)),
  );
  playerFields.soundDevice.value = playerSound.device ?? "";
  playerFields.soundLayout.value = playerSound.layout;
  playerFields.soundDelayMilliseconds.value = playerSound.delayMilliseconds;
  playerFields.subtitleOffsetPercent.value = playerSubtitles.offsetPercent;
  playerFields.subtitleColourOverridden.checked = playerSubtitles.colour !== null;
  playerFields.subtitleColour.value = playerSubtitles.colour ?? DEFAULT_SUBTITLE_COLOUR;
  enableSubtitleColour();
}

function playerControlsFromForm() {
  return playerControlsFromFields({
    brightness: playerFields.brightness.value,
    maskTop: playerFields.maskTop.value,
    maskBottom: playerFields.maskBottom.value,
    maskLeft: playerFields.maskLeft.value,
    maskRight: playerFields.maskRight.value,
    scaling: playerFields.scaling.value,
    soundDevice: playerFields.soundDevice.value,
    soundLayout: playerFields.soundLayout.value,
    soundDelayMilliseconds: playerFields.soundDelayMilliseconds.value,
    subtitleOffsetPercent: playerFields.subtitleOffsetPercent.value,
    subtitleColourOverridden: playerFields.subtitleColourOverridden.checked,
    subtitleColour: playerFields.subtitleColour.value,
  });
}

async function applyPlayerControls(settings) {
  for (const [command, args] of playerControlCommands(appliedPlayerControls, settings)) {
    await invoke(command, args);
  }
  const { playerPicture, playerSound, playerSubtitles } = settings;
  appliedPlayerControls = { playerPicture, playerSound, playerSubtitles };
}

function showPlayerWarnings(metadata) {
  const warning = playerWarningText(metadata.warnings);
  if (warning === shownPlayerWarning) return;
  if (warning) setStatus(warning);
  else if (document.getElementById("status-text")?.textContent === shownPlayerWarning) setStatus(READY_STATUS);
  shownPlayerWarning = warning;
}

async function showSettings() {
  const settings = await invoke("load_settings");
  libraryRoots = settings.libraryRoots;
  certificateInput.value = settings.recipientCertificate ?? "";
  privateKeyInput.value = settings.recipientKey ?? "";
  fillGpuSettings(settings);
  renderLibraryRoots();
  await fillPlayerSettings(settings);
  return settings;
}

function reportGpuFailure(gpuFailure) {
  uncheckGpu();
  setStatus(`${GPU_UNAVAILABLE_STATUS}: ${gpuFailure}`);
}

async function applySavedSettings() {
  const settings = await showSettings();
  await applyPlayerControls(settings);
  const gpuFailure = await applyGpuSetting(settings);
  if (!gpuFailure) return;
  reportGpuFailure(gpuFailure);
  await invoke("save_settings", { settings: { ...settings, gpu: false } });
}

async function browseInto(input, filters) {
  const path = await open({ filters });
  if (path) input.value = path;
}

document.getElementById("set-library-roots-add").addEventListener("click", reportingErrors(async () => {
  const folder = await open({ directory: true });
  if (!folder) return;
  libraryRoots = withLibraryRoot(libraryRoots, folder);
  renderLibraryRoots();
}));
document.getElementById("set-recipient-certificate-browse")
  .addEventListener("click", reportingErrors(() => browseInto(certificateInput, CERTIFICATE_FILTERS)));
document.getElementById("set-recipient-key-browse")
  .addEventListener("click", reportingErrors(() => browseInto(privateKeyInput, PRIVATE_KEY_FILTERS)));
document.getElementById("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  reportingErrors(async () => {
    const settings = settingsFromFields({
      libraryRoots,
      recipientCertificate: certificateInput.value,
      recipientKey: privateKeyInput.value,
      ...gpuSettingsFromForm(),
      playerMonitor: playerMonitorSelect.value,
    });
    Object.assign(settings, playerControlsFromForm());
    const gpuFailure = await applyGpuSetting(settings);
    await invoke("save_settings", { settings: gpuFailure ? { ...settings, gpu: false } : settings });
    await applyPlayerControls(settings);
    setStatus(SETTINGS_SAVED_STATUS);
    await refreshLibraryFromDisk();
    if (gpuFailure) reportGpuFailure(gpuFailure);
  })();
});

playerFields.brightness.addEventListener("input", showBrightness);
playerFields.subtitleColourOverridden.addEventListener("change", enableSubtitleColour);
watchPreviewMetadata(showPlayerWarnings);

initGpuSettings();
initPreview();
reportingErrors(applySavedSettings)();
refreshLibrary();
startLibraryPolling();

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window, availableMonitors, currentMonitor } from "@tauri-apps/api/window";
import { open, message } from "@tauri-apps/plugin-dialog";
import { enablePreviewTransport, initPreview, previewFile, stopPreview, watchPreviewMetadata } from "../../extern/guikit/src/preview.js";
import { initJobsPanel, refreshJobs, startJobsPolling, stopJobsPolling } from "../../extern/guikit/src/jobs.js";
import { initLibraryPanel, refreshLibrary } from "../../extern/guikit/src/library.js";
import { initKeysPanel, refreshKeys } from "../../extern/guikit/src/keys.js";
import { initGpuSettings, fillGpuSettings, gpuSettingsFromForm, uncheckGpu, applyGpuSetting } from "../../extern/guikit/src/gpu-settings.js";
import { settingsFromFields, withLibraryRoot, withoutLibraryRoot } from "./settings-form.js";
import { playRefusalText } from "./play-refusal.js";
import {
  IN_POINT,
  OUT_POINT,
  compositionLengths,
  displayTime,
  formatTimecode,
  frameAtPosition,
  isSameComposition,
  newPlaylist,
  parseTimecode,
  rangeFrameCount,
  rowLength,
  rowTitle,
  runnerStatusText,
  warningText,
  withComposition,
  withIntermission,
  withRangePoint,
  withRowMoved,
  withStartTime,
  withoutRow,
} from "./screening-playlist.js";
import { playerMonitorChoices } from "./player-monitor.js";
import {
  DISPLAY_PROFILE_COMMAND,
  displayProfileChoices,
  fillPlayerControlFields,
  playerControlCommands,
  playerControlsFromFields,
  playerWarningText,
  soundDeviceChoices,
} from "./player-controls.js";

const KDM_FILTERS = [{ name: "KDM", extensions: ["xml"] }];
const CERTIFICATE_FILTERS = [{ name: "Certificate", extensions: ["pem", "crt"] }];
const PRIVATE_KEY_FILTERS = [{ name: "Private key", extensions: ["pem", "key"] }];
const DISPLAY_PROFILE_FILTERS = [{ name: "ICC profile", extensions: ["icc", "icm"] }];
const COLORD_PROFILES_TEXT = "Profiles colord has for this display";
const NO_COLORD_PROFILES_TEXT = "colord has no profile for this display";
const DISPLAY_PROFILE_REFUSED_STATUS = "Monitor profile refused";
const STILL_IMAGE_FILTERS = [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }];
const DEFAULT_PLAYLIST_NAME = "Playlist";
const PLAYLIST_SAVED_STATUS = "Playlist saved";
const PLAYLIST_POLL_INTERVAL_MS = 1000;
const SECONDS_PER_MINUTE = 60;
// hides the placeholder date WebKit draws in an empty field
const EMPTY_START_TIME_CLASS = "start-time-empty";
const MOVE_UP = -1;
const PLAYING_ACTIVITY = "playing";
const SET_FROM_PLAYER_CLASS = "btn-set-from-player";
const IN_PLACEHOLDER = "start";
const OUT_PLACEHOLDER = "end";
const SET_IN_TITLE = "Start the row at the frame on screen";
const SET_OUT_TITLE = "End the row before the frame on screen";
const MOVE_DOWN = 1;
const PLAY_SOURCE_READY = "ready";
const PLAY_REFUSAL_TITLE = "No KDM fits";
const PLAY_SOURCE_REFUSED = "refused";
const NOT_PLAYED_TITLE = "Not played";
const PLAYBACK_STOPPED_TITLE = "Playback stopped";
// the backend stopped an encrypted composition the output no longer protects
const HDCP_STOPPED_EVENT = "hdcp-stopped";
const SETTINGS_SAVED_STATUS = "Settings saved";
const GPU_UNAVAILABLE_STATUS = "GPU decoding unavailable";
const LIBRARY_POLL_INTERVAL_MS = 3000;
const REMOVE_ROOT_TEXT = "✕";
const PLAYER_WINDOW_LABEL = "player";
// the Rust side sends it when the window manager closes the player window
const PLAYER_CLOSE_REQUESTED_EVENT = "player-close-requested";
const MAIN_WINDOW_MONITOR_TEXT = "Same as the main window";
const READY_STATUS = "Ready";
const BRIGHTNESS_DECIMALS = 2;
const SETTINGS_LOCKED = "locked";
const SETTINGS_UNLOCKED_STATUS = "Settings unlocked";
const SETTINGS_LOCKED_STATUS = "Settings locked";
const PASSWORD_CHANGED_STATUS = "Settings password changed";
const PASSWORD_REMOVED_STATUS = "Settings password removed";

const certificateInput = document.getElementById("set-recipient-certificate");
const privateKeyInput = document.getElementById("set-recipient-key");
const libraryRootsList = document.getElementById("set-library-roots");
const playerMonitorSelect = document.getElementById("set-player-monitor");
const requireHdcpCheckbox = document.getElementById("set-require-hdcp");
const playerFields = {
  brightness: document.getElementById("set-player-brightness"),
  brightnessValue: document.getElementById("set-player-brightness-value"),
  maskTop: document.getElementById("set-player-mask-top"),
  maskBottom: document.getElementById("set-player-mask-bottom"),
  maskLeft: document.getElementById("set-player-mask-left"),
  maskRight: document.getElementById("set-player-mask-right"),
  scaling: document.getElementById("set-player-scaling"),
  soundDevice: document.getElementById("set-player-sound-device"),
  soundDeviceError: document.getElementById("set-player-sound-device-error"),
  soundLayout: document.getElementById("set-player-sound-layout"),
  soundDelayMilliseconds: document.getElementById("set-player-sound-delay"),
  subtitleOffsetPercent: document.getElementById("set-player-subtitle-offset"),
  subtitleColourOverridden: document.getElementById("set-player-subtitle-colour-overridden"),
  subtitleColour: document.getElementById("set-player-subtitle-colour"),
  displayProfile: document.getElementById("set-player-display-profile"),
  stereo: document.getElementById("set-player-stereo"),
  colordProfiles: document.getElementById("set-player-display-profile-colord"),
  displayProfileError: document.getElementById("set-player-display-profile-error"),
};
const settingsView = document.getElementById("view-settings");
const passwordFields = {
  unlock: document.getElementById("settings-unlock-password"),
  current: document.getElementById("settings-current-password"),
  new: document.getElementById("settings-new-password"),
  confirmation: document.getElementById("settings-new-password-confirmation"),
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
    if (btn.dataset.view === "playlist") reportingErrors(async () => {
      await refreshSavedPlaylists();
      await renderPlaylist();
    })();
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
  await invoke("playlist_stop");
  stopPreview();
  await playerWindow.hide();
}

// the window shows first, so the HDCP check reads the output it is on
async function playComposition(libraryPackage, composition) {
  await invoke("playlist_stop");
  await showPlayerWindow();
  const source = await invoke("library_play", { directory: libraryPackage.directory, cplId: composition.id })
    .catch((error) => ({ kind: PLAY_SOURCE_REFUSED, error }));
  if (source.kind === PLAY_SOURCE_READY) {
    await previewFile(source.cplPath, source.contentKeys, source.otherPackages);
    return;
  }
  await playerWindow.hide();
  if (source.kind === PLAY_SOURCE_REFUSED) {
    await message(String(source.error), { title: NOT_PLAYED_TITLE, kind: "warning" });
    return;
  }
  await message(playRefusalText(composition.title, source.kdms), { title: PLAY_REFUSAL_TITLE, kind: "warning" });
}

const playlistFields = {
  name: document.getElementById("playlist-name"),
  saved: document.getElementById("playlist-saved"),
  rows: document.getElementById("playlist-tbody"),
  warnings: document.getElementById("playlist-warnings"),
  runnerStatus: document.getElementById("playlist-runner-status"),
  intermissionMinutes: document.getElementById("playlist-intermission-minutes"),
  intermissionStill: document.getElementById("playlist-intermission-still"),
};
let currentPlaylist = newPlaylist(DEFAULT_PLAYLIST_NAME);
// the copy the runner was started with, its row numbers are the ones the runner state gives
let playingPlaylist = null;
let latestRunnerState = null;
// seconds from the loaded row's in frame, null while nothing plays
let latestPlayerPosition = null;
let libraryLengths = new Map();

function rowButton(text, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-sm";
  button.textContent = text;
  button.title = title;
  button.addEventListener("click", reportingErrors(onClick));
  return button;
}

function cell(...children) {
  const td = document.createElement("td");
  td.append(...children);
  return td;
}

function rangeInput(row, index, point, length) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "playlist-timecode";
  input.placeholder = point === IN_POINT ? IN_PLACEHOLDER : OUT_PLACEHOLDER;
  input.value = row[point] === undefined ? "" : formatTimecode(row[point], length.framesPerSecond);
  input.addEventListener("change", reportingErrors(() =>
    editPlaylist(withRangePoint(currentPlaylist, index, point, parseTimecode(input.value, length.framesPerSecond)))));
  return input;
}

// the runner's row, while this row of the view is the composition it plays
function playingRunnerRow(index) {
  if (latestRunnerState?.activity !== PLAYING_ACTIVITY || !playingPlaylist) return null;
  const runnerRow = playingPlaylist.rows[latestRunnerState.currentRow];
  return isSameComposition(runnerRow, currentPlaylist.rows[index]) && latestRunnerState.currentRow === index ? runnerRow : null;
}

function setFromPlayerButton(text, title, index, point, length) {
  const button = rowButton(text, title, () => {
    const runnerRow = playingRunnerRow(index);
    if (!runnerRow || latestPlayerPosition === null) return;
    const frame = frameAtPosition(runnerRow, latestPlayerPosition, length.framesPerSecond);
    return editPlaylist(withRangePoint(currentPlaylist, index, point, frame));
  });
  button.classList.add(SET_FROM_PLAYER_CLASS);
  button.dataset.row = String(index);
  button.disabled = !playingRunnerRow(index);
  return button;
}

function rangeCells(row, index) {
  const length = rowLength(libraryLengths, row);
  if (!length) return [cell(), cell(), cell()];
  return [
    cell(rangeInput(row, index, IN_POINT, length), setFromPlayerButton("Set", SET_IN_TITLE, index, IN_POINT, length)),
    cell(rangeInput(row, index, OUT_POINT, length), setFromPlayerButton("Set", SET_OUT_TITLE, index, OUT_POINT, length)),
    cell(formatTimecode(rangeFrameCount(row, length.frameCount), length.framesPerSecond)),
  ];
}

function enableSetFromPlayerButtons() {
  document.querySelectorAll(`.${SET_FROM_PLAYER_CLASS}`).forEach((button) => {
    button.disabled = !playingRunnerRow(Number(button.dataset.row));
  });
}

function playlistRowElement(row, index, expectedStart) {
  const startTime = document.createElement("input");
  startTime.type = "datetime-local";
  startTime.step = "1";
  startTime.value = row.startTime ?? "";
  startTime.classList.toggle(EMPTY_START_TIME_CLASS, !startTime.value);
  startTime.addEventListener("change", reportingErrors(() => editPlaylist(withStartTime(currentPlaylist, index, startTime.value))));
  const actions = [
    rowButton("↑", "Move up", () => editPlaylist(withRowMoved(currentPlaylist, index, MOVE_UP))),
    rowButton("↓", "Move down", () => editPlaylist(withRowMoved(currentPlaylist, index, MOVE_DOWN))),
    rowButton("✕", "Remove", () => editPlaylist(withoutRow(currentPlaylist, index))),
    rowButton("Play from here", "Play the playlist from this row", () => playPlaylist(index)),
  ];
  const tr = document.createElement("tr");
  tr.append(
    cell(String(index + 1)),
    cell(rowTitle(row)),
    ...rangeCells(row, index),
    cell(startTime),
    cell(expectedStart ? displayTime(expectedStart) : ""),
    cell(...actions),
  );
  return tr;
}

async function renderPlaylist() {
  playlistFields.name.value = currentPlaylist.name;
  libraryLengths = compositionLengths((await invoke("library_list")).packages);
  const plan = await invoke("playlist_plan", { playlist: currentPlaylist, fromRow: 0 });
  const expectedStarts = new Map(plan.rows.map((planned) => [planned.row, planned.expectedStart]));
  playlistFields.rows.replaceChildren(...currentPlaylist.rows.map((row, index) => playlistRowElement(row, index, expectedStarts.get(index))));
  playlistFields.warnings.replaceChildren(...plan.warnings.map((warning) => {
    const item = document.createElement("li");
    item.textContent = warningText(warning);
    return item;
  }));
}

async function editPlaylist(playlist) {
  currentPlaylist = playlist;
  await renderPlaylist();
}

async function refreshSavedPlaylists() {
  const names = await invoke("playlist_list");
  playlistFields.saved.replaceChildren(...names.map((name) => choiceOption(name, name)));
}

async function addToPlaylist(libraryPackage, composition) {
  await editPlaylist(withComposition(currentPlaylist, libraryPackage, composition));
  setStatus(`Added ${composition.title} to ${currentPlaylist.name}`);
}

async function playPlaylist(fromRow) {
  await showPlayerWindow();
  playingPlaylist = currentPlaylist;
  const state = await invoke("playlist_play", { playlist: currentPlaylist, fromRow });
  enablePreviewTransport();
  playlistFields.runnerStatus.textContent = runnerStatusText(state);
}

async function showRunnerState() {
  latestRunnerState = await invoke("playlist_state");
  playlistFields.runnerStatus.textContent = runnerStatusText(latestRunnerState);
  enableSetFromPlayerButtons();
}

playlistFields.name.addEventListener("change", () => {
  currentPlaylist = { ...currentPlaylist, name: playlistFields.name.value.trim() };
});
document.getElementById("playlist-save").addEventListener("click", reportingErrors(async () => {
  currentPlaylist = { ...currentPlaylist, name: playlistFields.name.value.trim() };
  await invoke("playlist_save", { playlist: currentPlaylist });
  await refreshSavedPlaylists();
  setStatus(`${PLAYLIST_SAVED_STATUS}: ${currentPlaylist.name}`);
}));
document.getElementById("playlist-open").addEventListener("click", reportingErrors(async () => {
  if (!playlistFields.saved.value) return;
  await editPlaylist(await invoke("playlist_open", { name: playlistFields.saved.value }));
}));
document.getElementById("playlist-new").addEventListener("click", reportingErrors(() => editPlaylist(newPlaylist(DEFAULT_PLAYLIST_NAME))));
document.getElementById("playlist-play").addEventListener("click", reportingErrors(() => playPlaylist(0)));
document.getElementById("playlist-stop").addEventListener("click", reportingErrors(stopPlayback));
document.getElementById("playlist-intermission-still-browse").addEventListener("click", reportingErrors(() =>
  browseInto(playlistFields.intermissionStill, STILL_IMAGE_FILTERS)));
document.getElementById("playlist-intermission-still-clear").addEventListener("click", () => {
  playlistFields.intermissionStill.value = "";
});
document.getElementById("playlist-intermission-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = Math.round(Number(playlistFields.intermissionMinutes.value) * SECONDS_PER_MINUTE);
  reportingErrors(() => editPlaylist(withIntermission(currentPlaylist, seconds, playlistFields.intermissionStill.value)))();
});
setInterval(() => showRunnerState().catch((error) => setStatus(String(error))), PLAYLIST_POLL_INTERVAL_MS);

initLibraryPanel({
  tableBody: document.getElementById("library-tbody"),
  statusBadge: document.getElementById("library-status"),
  load: () => invoke("library_list"),
  actions: {
    play: reportingErrors(playComposition),
    addToPlaylist: reportingErrors(addToPlaylist),
    verify: reportingErrors((libraryPackage) => invoke("library_verify", { directory: libraryPackage.directory })),
    remove: reportingErrors((libraryPackage) => invoke("library_remove", { directory: libraryPackage.directory })),
  },
});
document.getElementById("library-refresh").addEventListener("click", reportingErrors(refreshLibraryFromDisk));
document.getElementById("player-stop-btn").addEventListener("click", reportingErrors(stopPlayback));
listen(PLAYER_CLOSE_REQUESTED_EVENT, reportingErrors(stopPlayback));
listen(HDCP_STOPPED_EVENT, reportingErrors(async (event) => {
  await stopPlayback();
  setStatus(event.payload);
  await message(event.payload, { title: PLAYBACK_STOPPED_TITLE, kind: "warning" });
}));
if (!(await invoke("hdcp_supported"))) {
  requireHdcpCheckbox.disabled = true;
  document.getElementById("set-require-hdcp-unsupported").hidden = false;
}

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
  await fillColordProfiles();
  await fillPlayerControls(settings);
}

// the display full screen goes to, which is the main window's when none is chosen
async function fullScreenDisplayName() {
  return playerMonitorSelect.value || (await currentMonitor())?.name;
}

async function fillColordProfiles() {
  const name = await fullScreenDisplayName();
  const choices = name ? displayProfileChoices(await invoke("display_profiles", { monitor: name })) : [];
  const placeholder = choices.length ? COLORD_PROFILES_TEXT : NO_COLORD_PROFILES_TEXT;
  playerFields.colordProfiles.replaceChildren(
    choiceOption("", placeholder),
    ...choices.map((choice) => {
      const option = choiceOption(choice.path, choice.label);
      option.title = choice.path;
      return option;
    }),
  );
}

function showBrightness() {
  playerFields.brightnessValue.value = Number(playerFields.brightness.value).toFixed(BRIGHTNESS_DECIMALS);
}

function enableSubtitleColour() {
  playerFields.subtitleColour.disabled = !playerFields.subtitleColourOverridden.checked;
}

async function fillPlayerControls(settings) {
  await fillPlayerControlFields(playerFields, settings, {
    listSoundDevices: () => invoke("preview_sound_devices"),
    makeOption: choiceOption,
  });
  showBrightness();
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
    displayProfile: playerFields.displayProfile.value,
    stereo: playerFields.stereo.value,
  });
}

function showDisplayProfileError(error) {
  playerFields.displayProfileError.textContent = String(error);
  playerFields.displayProfileError.hidden = false;
  setStatus(`${DISPLAY_PROFILE_REFUSED_STATUS}: ${error}`);
}

// a refused profile leaves the one the player has, and the reason goes under the field
async function applyDisplayProfile(args) {
  playerFields.displayProfileError.hidden = true;
  await invoke(DISPLAY_PROFILE_COMMAND, args).catch(showDisplayProfileError);
}

// false when the player would refuse the chosen profile, which is then not saved
async function displayProfileAccepted(profile) {
  playerFields.displayProfileError.hidden = true;
  if (!profile) return true;
  return invoke("settings_check_display_profile", { profile }).then(() => true, (error) => {
    showDisplayProfileError(error);
    return false;
  });
}

async function applyPlayerControls(settings) {
  for (const [command, args] of playerControlCommands(appliedPlayerControls, settings)) {
    if (command === DISPLAY_PROFILE_COMMAND) await applyDisplayProfile(args);
    else await invoke(command, args);
  }
  const { playerPicture, playerSound, playerSubtitles, playerDisplayProfile, playerStereo } = settings;
  appliedPlayerControls = { playerPicture, playerSound, playerSubtitles, playerDisplayProfile, playerStereo };
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
  settingsView.dataset.settingsLock = settings.settingsLock;
  libraryRoots = settings.libraryRoots;
  certificateInput.value = settings.recipientCertificate ?? "";
  privateKeyInput.value = settings.recipientKey ?? "";
  fillGpuSettings(settings);
  requireHdcpCheckbox.checked = settings.requireHdcp;
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
  if (settings.settingsLock === SETTINGS_LOCKED) return;
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
      requireHdcp: requireHdcpCheckbox.checked,
    });
    Object.assign(settings, playerControlsFromForm());
    if (!(await displayProfileAccepted(settings.playerDisplayProfile))) return;
    const gpuFailure = await applyGpuSetting(settings);
    await invoke("save_settings", { settings: gpuFailure ? { ...settings, gpu: false } : settings });
    await applyPlayerControls(settings);
    setStatus(SETTINGS_SAVED_STATUS);
    await refreshLibraryFromDisk();
    if (gpuFailure) reportGpuFailure(gpuFailure);
  })();
});

async function runPasswordCommand(command, args, doneStatus) {
  await invoke(command, args);
  Object.values(passwordFields).forEach((field) => {
    field.value = "";
  });
  await showSettings();
  setStatus(doneStatus);
}

document.getElementById("settings-unlock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  reportingErrors(() =>
    runPasswordCommand("settings_unlock", { password: passwordFields.unlock.value }, SETTINGS_UNLOCKED_STATUS))();
});
document.getElementById("settings-password-set").addEventListener("click", reportingErrors(() =>
  runPasswordCommand(
    "settings_lock_set",
    { password: passwordFields.new.value, confirmation: passwordFields.confirmation.value },
    SETTINGS_LOCKED_STATUS,
  )));
document.getElementById("settings-password-change").addEventListener("click", reportingErrors(() =>
  runPasswordCommand(
    "settings_lock_change",
    {
      currentPassword: passwordFields.current.value,
      password: passwordFields.new.value,
      confirmation: passwordFields.confirmation.value,
    },
    PASSWORD_CHANGED_STATUS,
  )));
document.getElementById("settings-password-remove").addEventListener("click", reportingErrors(() =>
  runPasswordCommand("settings_lock_remove", { currentPassword: passwordFields.current.value }, PASSWORD_REMOVED_STATUS)));
document.getElementById("settings-lock").addEventListener("click", reportingErrors(() =>
  runPasswordCommand("settings_lock", {}, SETTINGS_LOCKED_STATUS)));

playerFields.brightness.addEventListener("input", showBrightness);
document.getElementById("set-player-display-profile-browse")
  .addEventListener("click", reportingErrors(() => browseInto(playerFields.displayProfile, DISPLAY_PROFILE_FILTERS)));
document.getElementById("set-player-display-profile-clear").addEventListener("click", () => {
  playerFields.displayProfile.value = "";
});
playerFields.colordProfiles.addEventListener("change", () => {
  if (playerFields.colordProfiles.value) playerFields.displayProfile.value = playerFields.colordProfiles.value;
});
playerMonitorSelect.addEventListener("change", reportingErrors(fillColordProfiles));
playerFields.subtitleColourOverridden.addEventListener("change", enableSubtitleColour);
watchPreviewMetadata((metadata) => {
  latestPlayerPosition = metadata.position ?? null;
  showPlayerWarnings(metadata);
});

initGpuSettings();
initPreview();
reportingErrors(applySavedSettings)();
refreshLibrary();
startLibraryPolling();

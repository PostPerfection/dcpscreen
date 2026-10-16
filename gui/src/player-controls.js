import {
  playerControlsFromFields as sharedPlayerControlsFromFields,
  soundDeviceChoices,
} from "../../extern/guikit/src/player-controls.js";

export {
  DISPLAY_PROFILE_COMMAND,
  playerControlCommands,
  soundDeviceChoices,
} from "../../extern/guikit/src/player-controls.js";

const WARNING_PREFIX = "Player: ";
const WARNING_SEPARATOR = ". ";
const DEFAULT_SOUND_DEVICE_TEXT = "Default";
const DEFAULT_SUBTITLE_COLOUR = "#ffffff";
const SOUND_DEVICES_FAILED_TEXT = "The sound devices could not be listed";

export function playerControlsFromFields(fields) {
  return { ...sharedPlayerControlsFromFields(fields), cpuDecodeResolution: fields.cpuDecodeResolution };
}

// the colord profiles as choices, the file name shown and the path kept
export function displayProfileChoices(paths) {
  return paths.map((path) => ({ path, label: path.split(/[/\\]/).pop() }));
}

// null when the player has nothing to warn about
export function playerWarningText(warnings) {
  if (!warnings || warnings.length === 0) return null;
  return WARNING_PREFIX + warnings.join(WARNING_SEPARATOR);
}

// every field fills on its own, and a device list that fails leaves the saved device and says why
export async function fillPlayerControlFields(fields, settings, { listSoundDevices, makeOption }) {
  const {
    playerPicture,
    playerSound,
    playerSubtitles,
    playerDisplayProfile,
    playerStereo,
    playerLevelMeter,
    cpuDecodeResolution,
  } = settings;
  fields.displayProfile.value = playerDisplayProfile ?? "";
  fields.stereo.value = playerStereo;
  fields.cpuDecodeResolution.value = cpuDecodeResolution;
  fields.brightness.value = playerPicture.brightness;
  fields.maskTop.value = playerPicture.masksPercent.top;
  fields.maskBottom.value = playerPicture.masksPercent.bottom;
  fields.maskLeft.value = playerPicture.masksPercent.left;
  fields.maskRight.value = playerPicture.masksPercent.right;
  fields.scaling.value = playerPicture.scaling;
  fields.soundLayout.value = playerSound.layout;
  fields.soundDelayMilliseconds.value = playerSound.delayMilliseconds;
  fields.subtitleOffsetPercent.value = playerSubtitles.offsetPercent;
  fields.subtitleColourOverridden.checked = playerSubtitles.colour !== null;
  fields.subtitleColour.value = playerSubtitles.colour ?? DEFAULT_SUBTITLE_COLOUR;
  fields.levelMeter.checked = playerLevelMeter;
  const listing = await listSoundDevices().then(
    (names) => ({ names, error: null }),
    (error) => ({ names: [], error: `${SOUND_DEVICES_FAILED_TEXT}: ${error}` }),
  );
  const devices = soundDeviceChoices(listing.names, playerSound.device);
  fields.soundDevice.replaceChildren(
    makeOption("", DEFAULT_SOUND_DEVICE_TEXT),
    ...devices.map((device) => makeOption(device.name, device.label)),
  );
  fields.soundDevice.value = playerSound.device ?? "";
  fields.soundDeviceError.textContent = listing.error ?? "";
  fields.soundDeviceError.hidden = listing.error === null;
}

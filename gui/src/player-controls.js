import { withSavedChoice } from "./saved-choices.js";

const WARNING_PREFIX = "Player: ";
const WARNING_SEPARATOR = ". ";
export const DISPLAY_PROFILE_COMMAND = "preview_set_display_profile";
const DEFAULT_SOUND_DEVICE_TEXT = "Default";
const DEFAULT_SUBTITLE_COLOUR = "#ffffff";
const SOUND_DEVICES_FAILED_TEXT = "The sound devices could not be listed";

export function playerControlsFromFields({
  brightness,
  maskTop,
  maskBottom,
  maskLeft,
  maskRight,
  scaling,
  soundDevice,
  soundLayout,
  soundDelayMilliseconds,
  subtitleOffsetPercent,
  subtitleColourOverridden,
  subtitleColour,
  displayProfile,
}) {
  return {
    playerPicture: {
      brightness: Number(brightness),
      masksPercent: {
        top: Number(maskTop),
        bottom: Number(maskBottom),
        left: Number(maskLeft),
        right: Number(maskRight),
      },
      scaling,
    },
    playerSound: {
      device: soundDevice || null,
      layout: soundLayout,
      delayMilliseconds: Math.round(Number(soundDelayMilliseconds)),
    },
    playerSubtitles: {
      offsetPercent: Number(subtitleOffsetPercent),
      colour: subtitleColourOverridden ? subtitleColour : null,
    },
    playerDisplayProfile: displayProfile || null,
  };
}

function sameValue(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

// the commands that bring the player from the applied controls to these, all of them when none are applied
export function playerControlCommands(applied, settings) {
  const changed = (read) => !applied || !sameValue(read(applied), read(settings));
  const commands = [];
  if (changed((controls) => controls.playerPicture)) {
    commands.push(["preview_set_picture", { picture: settings.playerPicture }]);
  }
  if (changed((controls) => controls.playerSound.device)) {
    commands.push(["preview_set_sound_device", { device: settings.playerSound.device }]);
  }
  if (changed((controls) => controls.playerSound.layout)) {
    commands.push(["preview_set_sound_layout", { layout: settings.playerSound.layout }]);
  }
  if (changed((controls) => controls.playerSound.delayMilliseconds)) {
    commands.push(["preview_set_sound_delay", { milliseconds: settings.playerSound.delayMilliseconds }]);
  }
  if (changed((controls) => controls.playerSubtitles)) {
    commands.push(["preview_set_subtitle_presentation", { subtitles: settings.playerSubtitles }]);
  }
  if (changed((controls) => controls.playerDisplayProfile)) {
    commands.push([DISPLAY_PROFILE_COMMAND, { profile: settings.playerDisplayProfile }]);
  }
  return commands;
}

// the colord profiles as choices, the file name shown and the path kept
export function displayProfileChoices(paths) {
  return paths.map((path) => ({ path, label: path.split(/[/\\]/).pop() }));
}

export function soundDeviceChoices(deviceNames, savedDevice) {
  return withSavedChoice(
    deviceNames.map((name) => ({ name, label: name })),
    savedDevice,
  );
}

// null when the player has nothing to warn about
export function playerWarningText(warnings) {
  if (!warnings || warnings.length === 0) return null;
  return WARNING_PREFIX + warnings.join(WARNING_SEPARATOR);
}

// every field fills on its own, and a device list that fails leaves the saved device and says why
export async function fillPlayerControlFields(fields, settings, { listSoundDevices, makeOption }) {
  const { playerPicture, playerSound, playerSubtitles, playerDisplayProfile } = settings;
  fields.displayProfile.value = playerDisplayProfile ?? "";
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

import { withSavedChoice } from "./saved-choices.js";

const WARNING_PREFIX = "Player: ";
const WARNING_SEPARATOR = ". ";

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
  return commands;
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

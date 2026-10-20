// preview_set_sound_source's names for the two tracks
const SOURCE_LABELS = { atmos: "Atmos", main: "Main" };
const OTHER_SOURCE = { atmos: "main", main: "atmos" };
const HUD_PREFIX = "Sound: ";

// null while the composition does not carry Atmos on every reel
export function soundSourceHudText(meta) {
  if (!meta.atmos_available) return null;
  return HUD_PREFIX + SOURCE_LABELS[meta.sound_source];
}

export function nextSoundSource(meta) {
  return OTHER_SOURCE[meta.sound_source];
}

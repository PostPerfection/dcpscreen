const STEREO_MODE_LABELS = {
  leftEye: "Left eye",
  rightEye: "Right eye",
  sideBySide: "Side by side",
  topAndBottom: "Top and bottom",
};
const STEREO_MODES = Object.keys(STEREO_MODE_LABELS);
const HUD_PREFIX = "3D: ";

// null for a mono source, which the 3D output does not touch
export function stereoHudText(stereoscopic, mode) {
  if (!stereoscopic) return null;
  return HUD_PREFIX + STEREO_MODE_LABELS[mode];
}

export function nextStereoMode(mode) {
  return STEREO_MODES[(STEREO_MODES.indexOf(mode) + 1) % STEREO_MODES.length];
}

export const AUTOMATIC_RESOLUTION = "automatic";
const FULL_SCALE = "full";
// lightest last, a step down moves one place right
const DECODE_SCALES = [FULL_SCALE, "half", "quarter"];
const SCALE_HUD_TEXT = { half: "Half resolution", quarter: "Quarter resolution" };
// below this share of the container rate the decode is falling behind
const BEHIND_RATIO = 0.95;
const STEP_DOWN_AFTER_MS = 3000;
// a frame dropped undecoded counts as behind for this long
const DROP_COUNTS_AS_BEHIND_MS = 1000;
// the lookahead refilling after a load or a step drops frames, twice the player's one second rate window
const SETTLE_MS = 2000;
// a scale too slow to time its first decodes still gets judged
const SETTLE_CEILING_MS = 5000;

// the device decodes full resolution only, the Settings choice is for the cpu
export function startingScale(cpuResolution, gpuActive) {
  if (gpuActive || cpuResolution === AUTOMATIC_RESOLUTION) return FULL_SCALE;
  return cpuResolution;
}

// a load or an output mode change starts again at full, the only way back up
export function startPicker(now) {
  return {
    scale: FULL_SCALE,
    behindSince: null,
    lastStepAt: now,
    lastDropAt: null,
    droppedNotDecoded: null,
  };
}

function counting(sample) {
  return !sample.paused && !sample.eof && sample.container_fps > 0;
}

// until the player has timed the decode at this scale, or on time alone for a player that reports no capacity
function settling(state, sample, now) {
  const sinceStep = now - state.lastStepAt;
  if (sinceStep >= SETTLE_CEILING_MS) return false;
  const capacityTimed = !("decode_capacity_fps" in sample) || typeof sample.decode_capacity_fps === "number";
  return sinceStep < SETTLE_MS || !capacityTimed;
}

// the picker after one metadata sample, its scale is what the player should decode at
export function nextPicker(state, sample, now, cpuResolution, gpuActive) {
  const picking = !gpuActive && cpuResolution === AUTOMATIC_RESOLUTION;
  if (!picking) return { ...startPicker(now), scale: startingScale(cpuResolution, gpuActive) };
  const dropped = sample.dropped_frames_not_decoded ?? 0;
  const unsettled = settling(state, sample, now);
  const newDrop = !unsettled && state.droppedNotDecoded !== null && dropped > state.droppedNotDecoded;
  const seen = { ...state, droppedNotDecoded: dropped, lastDropAt: newDrop ? now : state.lastDropAt };
  if (!counting(sample) || unsettled) return { ...seen, behindSince: null };
  const recentDrop = seen.lastDropAt !== null && now - seen.lastDropAt < DROP_COUNTS_AS_BEHIND_MS;
  const slow = typeof sample.decoder_fps === "number" && sample.decoder_fps < sample.container_fps * BEHIND_RATIO;
  if (!slow && !recentDrop) return { ...seen, behindSince: null };
  const behindSince = seen.behindSince ?? now;
  const lightest = seen.scale === DECODE_SCALES.at(-1);
  if (now - behindSince < STEP_DOWN_AFTER_MS || lightest) return { ...seen, behindSince };
  const scale = DECODE_SCALES[DECODE_SCALES.indexOf(seen.scale) + 1];
  return { ...seen, scale, behindSince: null, lastStepAt: now };
}

// null at full resolution
export function decodeScaleHudText(scale) {
  return SCALE_HUD_TEXT[scale] ?? null;
}

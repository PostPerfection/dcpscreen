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
// the next scale up costs about this many times the current one
const HEADROOM_RATIO = 2.2;
const STEP_UP_AFTER_MS = 10000;
// no two steps closer than this, so the scale never oscillates faster
const MINIMUM_STEP_INTERVAL_MS = STEP_DOWN_AFTER_MS;
// after a load or a step the lookahead refills at the new scale, which drops frames that are not
// a decode falling behind: twice the player's one second shown rate window, and the capacity measured
const SETTLE_MS = 2000;
// a scale too slow to time its first decodes still gets judged
const SETTLE_CEILING_MS = 5000;

// the scale a fixed Settings choice decodes at, or full where the picker starts
export function startingScale(resolution) {
  return resolution === AUTOMATIC_RESOLUTION ? FULL_SCALE : resolution;
}

// a load or an output mode change starts again at full
export function startPicker(now) {
  return {
    scale: FULL_SCALE,
    behindSince: null,
    headroomSince: null,
    lastStepAt: now,
    lastDropAt: null,
    droppedNotDecoded: null,
    // the capacity last seen at each scale, a scale that fell short of the rate is never stepped up to
    capacityByScale: {},
  };
}

function step(state, offset, now) {
  const scale = DECODE_SCALES[DECODE_SCALES.indexOf(state.scale) + offset];
  return { ...state, scale, behindSince: null, headroomSince: null, lastStepAt: now };
}

function counting(sample) {
  return !sample.paused && !sample.eof && sample.container_fps > 0;
}

// a player that reports no capacity settles on time alone
function settling(state, sample, now) {
  const sinceStep = now - state.lastStepAt;
  if (sinceStep >= SETTLE_CEILING_MS) return false;
  const capacityTimed = !("decode_capacity_fps" in sample) || typeof sample.decode_capacity_fps === "number";
  return sinceStep < SETTLE_MS || !capacityTimed;
}

function fellShort(state, scale, containerFps) {
  const measured = state.capacityByScale[scale];
  return measured !== undefined && measured < containerFps;
}

// the picker after one metadata sample, its scale is what the player should decode at
export function nextPicker(state, sample, now) {
  const dropped = sample.dropped_frames_not_decoded ?? 0;
  const capacity = sample.decode_capacity_fps;
  const capacityByScale = typeof capacity === "number"
    ? { ...state.capacityByScale, [state.scale]: capacity }
    : state.capacityByScale;
  const unsettled = settling(state, sample, now);
  const newDrop = !unsettled && state.droppedNotDecoded !== null && dropped > state.droppedNotDecoded;
  const seen = { ...state, droppedNotDecoded: dropped, capacityByScale, lastDropAt: newDrop ? now : state.lastDropAt };
  if (!counting(sample) || unsettled) return { ...seen, behindSince: null, headroomSince: null };
  const containerFps = sample.container_fps;
  const recentDrop = seen.lastDropAt !== null && now - seen.lastDropAt < DROP_COUNTS_AS_BEHIND_MS;
  const slow = typeof sample.decoder_fps === "number" && sample.decoder_fps < containerFps * BEHIND_RATIO;
  const stepAllowed = now - seen.lastStepAt >= MINIMUM_STEP_INTERVAL_MS;
  if (slow || recentDrop) {
    const behindSince = seen.behindSince ?? now;
    const lightest = seen.scale === DECODE_SCALES.at(-1);
    if (now - behindSince >= STEP_DOWN_AFTER_MS && stepAllowed && !lightest) return step(seen, 1, now);
    return { ...seen, behindSince, headroomSince: null };
  }
  const above = DECODE_SCALES[DECODE_SCALES.indexOf(seen.scale) - 1];
  const roomy = typeof capacity === "number" && capacity >= containerFps * HEADROOM_RATIO;
  if (!roomy || above === undefined || fellShort(seen, above, containerFps)) {
    return { ...seen, behindSince: null, headroomSince: null };
  }
  const headroomSince = seen.headroomSince ?? now;
  if (now - headroomSince >= STEP_UP_AFTER_MS && stepAllowed) return step(seen, -1, now);
  return { ...seen, behindSince: null, headroomSince };
}

// null at full resolution
export function decodeScaleHudText(scale) {
  return SCALE_HUD_TEXT[scale] ?? null;
}

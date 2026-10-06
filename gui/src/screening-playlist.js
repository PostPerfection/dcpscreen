const PLAYLIST_FORMAT_VERSION = 2;
const COMPOSITION_KIND = "composition";
const INTERMISSION_KIND = "intermission";
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MINUTES_PER_HOUR = 60;
const LOCAL_TIME_SEPARATOR = "T";
const TIMECODE_PATTERN = /^(\d+):(\d{2}):(\d{2}):(\d{2})$/;
const TIMECODE_FIELD_WIDTH = 2;
const WAITING_TITLE = "Waiting";
const PLAYING_ACTIVITY = "playing";
const HOLDING_ACTIVITY = "holding";

export function newPlaylist(name) {
  return { version: PLAYLIST_FORMAT_VERSION, name, rows: [] };
}

function withRows(playlist, rows) {
  return { ...playlist, rows };
}

export function withComposition(playlist, libraryPackage, composition) {
  const row = {
    kind: COMPOSITION_KIND,
    packageDirectory: libraryPackage.directory,
    cplId: composition.id,
    title: composition.title,
  };
  return withRows(playlist, [...playlist.rows, row]);
}

// no still image holds black
export function withIntermission(playlist, seconds, stillImage) {
  const row = { kind: INTERMISSION_KIND, seconds };
  if (stillImage) row.stillImage = stillImage;
  return withRows(playlist, [...playlist.rows, row]);
}

export function withRowMoved(playlist, index, offset) {
  const target = index + offset;
  if (target < 0 || target >= playlist.rows.length) return playlist;
  const rows = [...playlist.rows];
  const [moved] = rows.splice(index, 1);
  rows.splice(target, 0, moved);
  return withRows(playlist, rows);
}

export function withoutRow(playlist, index) {
  return withRows(playlist, playlist.rows.filter((_, rowIndex) => rowIndex !== index));
}

// an empty value clears the start time
export function withStartTime(playlist, index, startTime) {
  const rows = playlist.rows.map((row, rowIndex) => {
    if (rowIndex !== index) return row;
    const { startTime: _cleared, ...unscheduled } = row;
    return startTime ? { ...row, startTime } : unscheduled;
  });
  return withRows(playlist, rows);
}

export const IN_POINT = "inFrame";
// the frame playback stops before
export const OUT_POINT = "outFrame";

// null clears the point, so the row plays from the first frame or to the end
export function withRangePoint(playlist, index, point, frame) {
  const rows = playlist.rows.map((row, rowIndex) => {
    if (rowIndex !== index) return row;
    const { [point]: _cleared, ...rest } = row;
    return frame === null ? rest : { ...rest, [point]: frame };
  });
  return withRows(playlist, rows);
}

function compositionKey(packageDirectory, cplId) {
  return `${packageDirectory}\n${cplId}`;
}

// frame count and rate of every library composition, for the rows that name one
export function compositionLengths(packages) {
  const lengths = new Map();
  for (const libraryPackage of packages) {
    for (const composition of libraryPackage.compositions) {
      const [numerator, denominator] = composition.editRate;
      lengths.set(compositionKey(libraryPackage.directory, composition.id), {
        frameCount: composition.durationFrames,
        framesPerSecond: numerator / denominator,
      });
    }
  }
  return lengths;
}

// undefined for an intermission or a composition the library does not have
export function rowLength(lengths, row) {
  if (row.kind !== COMPOSITION_KIND) return undefined;
  return lengths.get(compositionKey(row.packageDirectory, row.cplId));
}

export function isSameComposition(first, second) {
  return first?.kind === COMPOSITION_KIND && second?.kind === COMPOSITION_KIND
    && first.packageDirectory === second.packageDirectory && first.cplId === second.cplId;
}

// timecode counts whole frames, so a fractional rate counts at the nearest whole rate
function timecodeRate(framesPerSecond) {
  return Math.round(framesPerSecond);
}

export function formatTimecode(frame, framesPerSecond) {
  const rate = timecodeRate(framesPerSecond);
  const pad = (value) => String(value).padStart(TIMECODE_FIELD_WIDTH, "0");
  const seconds = Math.floor(frame / rate);
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % SECONDS_PER_MINUTE)}:${pad(frame % rate)}`;
}

// null for an empty field, which clears the point
export function parseTimecode(text, framesPerSecond) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const rate = timecodeRate(framesPerSecond);
  const match = TIMECODE_PATTERN.exec(trimmed);
  const [hours, minutes, seconds, frames] = match ? match.slice(1).map(Number) : [];
  if (!match || minutes >= MINUTES_PER_HOUR || seconds >= SECONDS_PER_MINUTE || frames >= rate) {
    throw new Error(`${trimmed} is not a timecode HH:MM:SS:FF at ${rate} frames a second`);
  }
  return ((hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds) * rate) + frames;
}

// what the plan counts too: the part of the range inside the composition
export function rangeFrameCount(row, frameCount) {
  return Math.max(0, Math.min(row.outFrame ?? frameCount, frameCount) - (row.inFrame ?? 0));
}

// the player counts its position from the row's in frame
export function frameAtPosition(row, positionSeconds, framesPerSecond) {
  return (row.inFrame ?? 0) + Math.round(positionSeconds * framesPerSecond);
}

export function rowTitle(row) {
  if (row.kind === COMPOSITION_KIND) return row.title;
  const held = row.stillImage ? `still ${row.stillImage.split(/[/\\]/).pop()}` : "black";
  return `Intermission, ${row.seconds} s of ${held}`;
}

export function formatCountdown(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const rest = String(whole % SECONDS_PER_MINUTE).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
  return `${minutes}:${rest}`;
}

export function displayTime(localTime) {
  return localTime.replace(LOCAL_TIME_SEPARATOR, " ");
}

export function warningText(warning) {
  const row = warning.row + 1;
  if (warning.kind === "missingComposition") return `Row ${row}: the composition is not in the library`;
  if (warning.kind === "rangeOutsideComposition") {
    return `Row ${row}: frames ${warning.inFrame} to ${warning.outFrame} are not inside the composition, which is ${warning.frameCount} frames long`;
  }
  return `Row ${row} is set for ${displayTime(warning.startTime)} but cannot start before ${displayTime(warning.earliestStart)}`;
}

// null when no playlist is running, a hold puts its countdown in the transport instead
export function playlistHudText(state) {
  if (!state || (state.activity !== PLAYING_ACTIVITY && state.activity !== HOLDING_ACTIVITY)) return null;
  const current = state.currentTitle ?? WAITING_TITLE;
  if (state.nextTitle === null) return { current, next: "" };
  const counting = state.activity === PLAYING_ACTIVITY && state.secondsToNextStart !== null;
  const countdown = counting ? ` in ${formatCountdown(state.secondsToNextStart)}` : "";
  return { current, next: `Next: ${state.nextTitle}${countdown}` };
}

// null unless a playlist is holding black or a still
export function holdCountdownText(state) {
  if (state?.activity !== HOLDING_ACTIVITY) return null;
  return `${formatCountdown(state.secondsToNextStart ?? 0)} left`;
}

export function runnerStatusText(state) {
  if (!state) return "Not playing";
  const errors = state.errors.length ? `. ${state.errors.join(". ")}` : "";
  const hud = playlistHudText(state);
  if (!hud) return `${state.playlistName}: ${state.activity}${errors}`;
  const next = hud.next ? `, ${hud.next.charAt(0).toLowerCase()}${hud.next.slice(1)}` : "";
  const holdLeft = holdCountdownText(state);
  const left = holdLeft ? `, ${holdLeft}` : "";
  return `${state.playlistName}: ${state.activity} ${hud.current}${next}${left}${errors}`;
}

const PLAYLIST_FORMAT_VERSION = 1;
const COMPOSITION_KIND = "composition";
const INTERMISSION_KIND = "intermission";
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const LOCAL_TIME_SEPARATOR = "T";
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

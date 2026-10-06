// the player's two subtitle slots, as preview_set_subtitle_visibility names them
export const SUBTITLE_SLOTS = ["subtitle", "caption"];
const SLOT_TRACK_FIELDS = { subtitle: "subtitle_track", caption: "caption_track" };
const SLOT_LABELS = { subtitle: "Subtitles", caption: "Captions" };
const OFF_SUFFIX = "off";

function loadedTracks(meta) {
  return SUBTITLE_SLOTS.map((slot) => ({ slot, track: meta[SLOT_TRACK_FIELDS[slot]] })).filter(({ track }) => track);
}

// null while the composition carries no subtitles or captions
export function subtitleHudText(meta) {
  const loaded = loadedTracks(meta);
  if (!loaded.length) return null;
  return loaded
    .map(({ slot, track }) => {
      const state = track.visible ? track.language ?? "" : OFF_SUFFIX;
      return `${SLOT_LABELS[slot]} ${state}`.trim();
    })
    .join(", ");
}

// one click hides every loaded track while any shows, and shows them all when none does
export function nextSubtitleVisibility(meta) {
  return !loadedTracks(meta).some(({ track }) => track.visible);
}

const LANGUAGE_HUD_PREFIX = "Language: ";

// the first loaded slot with a track in more than one language
function slotWithLanguages(meta) {
  return loadedTracks(meta).find(({ track }) => (track.languages ?? []).length > 1) ?? null;
}

// null while no slot has a choice of language
export function subtitleLanguageHudText(meta) {
  const choice = slotWithLanguages(meta);
  if (!choice) return null;
  return LANGUAGE_HUD_PREFIX + choice.track.language;
}

// the slot and the language after the one it shows, round to the first
export function nextSubtitleLanguage(meta) {
  const choice = slotWithLanguages(meta);
  if (!choice) return null;
  const { languages, language } = choice.track;
  return { slot: choice.slot, language: languages[(languages.indexOf(language) + 1) % languages.length] };
}

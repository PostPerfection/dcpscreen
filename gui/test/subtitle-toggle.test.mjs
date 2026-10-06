import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSubtitleLanguage, nextSubtitleVisibility, subtitleHudText, subtitleLanguageHudText } from '../src/subtitle-toggle.js';

const shown = (language) => ({ language, visible: true });
const hidden = (language) => ({ language, visible: false });

test('the HUD names each loaded track with its language, or off', () => {
  assert.equal(subtitleHudText({ subtitle_track: shown('fr'), caption_track: null }), 'Subtitles fr');
  assert.equal(subtitleHudText({ subtitle_track: hidden('fr'), caption_track: shown('en') }), 'Subtitles off, Captions en');
  assert.equal(subtitleHudText({ subtitle_track: shown(null), caption_track: null }), 'Subtitles');
});

test('a composition with no tracks shows no subtitle control', () => {
  assert.equal(subtitleHudText({ subtitle_track: null, caption_track: null }), null);
  assert.equal(subtitleHudText({}), null);
});

test('a click hides every track while one shows and shows them all when none does', () => {
  assert.equal(nextSubtitleVisibility({ subtitle_track: shown('fr'), caption_track: hidden('en') }), false);
  assert.equal(nextSubtitleVisibility({ subtitle_track: hidden('fr'), caption_track: hidden('en') }), true);
});

test('a slot with tracks in several languages offers the next one, round to the first', () => {
  const meta = { subtitle_track: { language: 'fr', languages: ['fr'], visible: true }, caption_track: { language: 'en', languages: ['fr', 'en'], visible: true } };
  assert.equal(subtitleLanguageHudText(meta), 'Language: en');
  assert.deepEqual(nextSubtitleLanguage(meta), { slot: 'caption', language: 'fr' });
});

test('one language a slot offers no choice', () => {
  const meta = { subtitle_track: { language: 'fr', languages: ['fr'], visible: true }, caption_track: null };
  assert.equal(subtitleLanguageHudText(meta), null);
  assert.equal(nextSubtitleLanguage(meta), null);
});

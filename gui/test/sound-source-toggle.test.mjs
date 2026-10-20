import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSoundSource, soundSourceHudText } from '../src/sound-source-toggle.js';

test('the HUD names the sound that plays while the composition carries Atmos', () => {
  assert.equal(soundSourceHudText({ sound_source: 'atmos', atmos_available: true }), 'Sound: Atmos');
  assert.equal(soundSourceHudText({ sound_source: 'main', atmos_available: true }), 'Sound: Main');
});

test('a composition without Atmos on every reel shows no sound control', () => {
  assert.equal(soundSourceHudText({ sound_source: 'main', atmos_available: false }), null);
  assert.equal(soundSourceHudText({ sound_source: null, atmos_available: false }), null);
  assert.equal(soundSourceHudText({}), null);
});

test('a click switches to the other track', () => {
  assert.equal(nextSoundSource({ sound_source: 'atmos', atmos_available: true }), 'main');
  assert.equal(nextSoundSource({ sound_source: 'main', atmos_available: true }), 'atmos');
});

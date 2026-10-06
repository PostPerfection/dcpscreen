import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStereoMode, stereoHudText } from '../src/stereo-output.js';

test('the HUD names the 3D output only for a stereoscopic source', () => {
  assert.equal(stereoHudText(true, 'sideBySide'), '3D: Side by side');
  assert.equal(stereoHudText(true, 'leftEye'), '3D: Left eye');
  assert.equal(stereoHudText(false, 'sideBySide'), null);
});

test('the HUD toggle steps through every output and back to the left eye', () => {
  const seen = ['leftEye'];
  for (let step = 0; step < 4; step += 1) seen.push(nextStereoMode(seen.at(-1)));
  assert.deepEqual(seen, ['leftEye', 'rightEye', 'sideBySide', 'topAndBottom', 'leftEye']);
});

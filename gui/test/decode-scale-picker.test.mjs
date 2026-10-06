import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeScaleHudText, nextPicker, startPicker, startingScale } from '../src/decode-scale-picker.js';

const SAMPLE_INTERVAL_MS = 250;
const RATE = 24;

function playing(fields) {
  return { paused: false, eof: false, container_fps: RATE, decoder_fps: RATE, dropped_frames_not_decoded: 0, ...fields };
}

// the scale after each sample, the first at time 0 and one every quarter second
function scalesOver(samples, state = startPicker(0)) {
  const scales = [];
  samples.forEach((sample, index) => {
    state = nextPicker(state, sample, index * SAMPLE_INTERVAL_MS);
    scales.push(state.scale);
  });
  return { scales, state };
}

function seconds(count, sample) {
  return Array(Math.round((count * 1000) / SAMPLE_INTERVAL_MS)).fill(sample);
}

function at(scales, milliseconds) {
  return scales[milliseconds / SAMPLE_INTERVAL_MS];
}

test('three seconds under 95 percent of the rate steps down once, then again after three more', () => {
  const { scales } = scalesOver(seconds(7, playing({ decoder_fps: 20 })));
  assert.equal(at(scales, 2750), 'full');
  assert.equal(at(scales, 3000), 'half');
  assert.equal(at(scales, 6000), 'half');
  assert.equal(at(scales, 6250), 'quarter');
});

test('a short dip under the rate does not step down', () => {
  const samples = [...seconds(2, playing({ decoder_fps: 20 })), ...seconds(5, playing())];
  assert.ok(scalesOver(samples).scales.every((scale) => scale === 'full'));
});

test('frames dropped undecoded keep counting as behind while the shown rate looks fine', () => {
  const samples = seconds(4, null).map((_, index) => playing({ dropped_frames_not_decoded: Math.floor(index / 2) }));
  assert.equal(scalesOver(samples).scales.at(-1), 'half');
});

test('the lightest scale stays put however far behind', () => {
  assert.equal(scalesOver(seconds(30, playing({ decoder_fps: 5 }))).scales.at(-1), 'quarter');
});

test('without the capacity field the picker never steps back up', () => {
  const samples = [...seconds(3.25, playing({ decoder_fps: 20 })), ...seconds(60, playing())];
  assert.equal(scalesOver(samples).scales.at(-1), 'half');
  const nulls = [...seconds(3.25, playing({ decoder_fps: 20 })), ...seconds(60, playing({ decode_capacity_fps: null }))];
  assert.equal(scalesOver(nulls).scales.at(-1), 'half');
});

test('ten seconds with capacity at 2.2 times the rate step up one place', () => {
  const samples = [...seconds(3.25, playing({ decoder_fps: 20 })), ...seconds(10.25, playing({ decode_capacity_fps: RATE * 2.2 }))];
  const { scales } = scalesOver(samples);
  assert.equal(at(scales, 3000), 'half');
  assert.equal(at(scales, 13000), 'half');
  assert.equal(at(scales, 13250), 'full');
});

test('capacity just under 2.2 times the rate never steps up', () => {
  const samples = [...seconds(3.25, playing({ decoder_fps: 20 })), ...seconds(60, playing({ decode_capacity_fps: RATE * 2.1 }))];
  assert.equal(scalesOver(samples).scales.at(-1), 'half');
});

test('alternating behind and roomy stretches never change the scale faster than the hold', () => {
  const samples = [];
  for (let round = 0; round < 6; round += 1) {
    samples.push(...seconds(3.5, playing({ decoder_fps: 20 })), ...seconds(10.5, playing({ decode_capacity_fps: RATE * 3 })));
  }
  let state = startPicker(0);
  let lastChangeAt = 0;
  let lastScale = state.scale;
  const gaps = [];
  samples.forEach((sample, index) => {
    const now = (index + 1) * SAMPLE_INTERVAL_MS;
    state = nextPicker(state, sample, now);
    if (state.scale === lastScale) return;
    gaps.push(now - lastChangeAt);
    lastChangeAt = now;
    lastScale = state.scale;
  });
  assert.ok(gaps.length >= 2, `the scale never moved: ${gaps}`);
  assert.ok(gaps.every((gap) => gap >= 3000), `steps closer than the hold: ${gaps}`);
});

test('paused, at the end or before the rate is known the timers stop', () => {
  const samples = [...seconds(2, playing({ decoder_fps: 20 })), ...seconds(5, playing({ decoder_fps: 20, paused: true })), ...seconds(2, playing({ decoder_fps: 20 }))];
  assert.ok(scalesOver(samples).scales.every((scale) => scale === 'full'));
  assert.ok(scalesOver(seconds(10, playing({ decoder_fps: 0, container_fps: null }))).scales.every((scale) => scale === 'full'));
});

test('a restart begins at full, and a fixed choice decodes at its own scale', () => {
  const { state } = scalesOver(seconds(4, playing({ decoder_fps: 20 })));
  assert.equal(state.scale, 'half');
  assert.equal(startPicker(5000).scale, 'full');
  assert.equal(startingScale('automatic'), 'full');
  assert.equal(startingScale('quarter'), 'quarter');
});

test('the HUD names the scale only when it is not full', () => {
  assert.equal(decodeScaleHudText('full'), null);
  assert.equal(decodeScaleHudText('half'), 'Half resolution');
  assert.equal(decodeScaleHudText('quarter'), 'Quarter resolution');
});

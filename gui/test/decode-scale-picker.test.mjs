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

test('after the two second settle, three seconds under 95 percent of the rate step down once, then again', () => {
  const { scales } = scalesOver(seconds(11, playing({ decoder_fps: 20 })));
  assert.equal(at(scales, 4750), 'full');
  assert.equal(at(scales, 5000), 'half');
  assert.equal(at(scales, 9750), 'half');
  assert.equal(at(scales, 10000), 'quarter');
});

test('a short dip under the rate does not step down', () => {
  const samples = [...seconds(2, playing({ decoder_fps: 20 })), ...seconds(5, playing())];
  assert.ok(scalesOver(samples).scales.every((scale) => scale === 'full'));
});

test('frames dropped undecoded keep counting as behind while the shown rate looks fine', () => {
  const samples = seconds(6, null).map((_, index) => playing({ dropped_frames_not_decoded: Math.floor(index / 2) }));
  const { scales } = scalesOver(samples);
  assert.equal(at(scales, 4750), 'full');
  assert.equal(at(scales, 5000), 'half');
});

test('the lightest scale stays put however far behind', () => {
  assert.equal(scalesOver(seconds(30, playing({ decoder_fps: 5 }))).scales.at(-1), 'quarter');
});

test('without the capacity field the picker never steps back up', () => {
  const samples = [...seconds(5.25, playing({ decoder_fps: 20 })), ...seconds(60, playing())];
  assert.equal(scalesOver(samples).scales.at(-1), 'half');
  const nulls = [...seconds(5.25, playing({ decoder_fps: 20 })), ...seconds(60, playing({ decode_capacity_fps: null }))];
  assert.equal(scalesOver(nulls).scales.at(-1), 'half');
});

test('ten seconds with capacity at 2.2 times the rate step up one place', () => {
  const samples = [...seconds(5.25, playing({ decoder_fps: 20 })), ...seconds(12, playing({ decode_capacity_fps: RATE * 2.2 }))];
  const { scales } = scalesOver(samples);
  assert.equal(at(scales, 5000), 'half');
  assert.equal(at(scales, 16750), 'half');
  assert.equal(at(scales, 17000), 'full');
});

test('capacity just under 2.2 times the rate never steps up', () => {
  const samples = [...seconds(5.25, playing({ decoder_fps: 20 })), ...seconds(60, playing({ decode_capacity_fps: RATE * 2.1 }))];
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
  const { state } = scalesOver(seconds(6, playing({ decoder_fps: 20 })));
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

test('drops and a low shown rate while the lookahead refills after a step do not count', () => {
  const samples = [
    ...seconds(5.25, playing({ decoder_fps: 20, decode_capacity_fps: 18 })),
    ...seconds(1, playing({ decoder_fps: 30, decode_capacity_fps: null, dropped_frames_not_decoded: 5 })),
    ...seconds(30, playing({ decoder_fps: 23.4, decode_capacity_fps: 78, dropped_frames_not_decoded: 5 })),
  ];
  const { scales } = scalesOver(samples);
  assert.equal(at(scales, 5000), 'half');
  assert.ok(scales.slice(21).every((scale) => scale === 'half'), scales.slice(21).join(' '));
});

test('a scale whose capacity fell short of the rate is never stepped back up to', () => {
  const samples = [
    ...seconds(5.25, playing({ decoder_fps: 20, decode_capacity_fps: 19 })),
    ...seconds(60, playing({ decode_capacity_fps: 78 })),
  ];
  assert.equal(scalesOver(samples).scales.at(-1), 'half');
});

test('a restart forgets the shortfall', () => {
  const { state } = scalesOver([
    ...seconds(5.25, playing({ decoder_fps: 20, decode_capacity_fps: 19 })),
    ...seconds(1, playing({ decode_capacity_fps: 78 })),
  ]);
  assert.deepEqual(state.capacityByScale, { full: 19, half: 78 });
  assert.deepEqual(startPicker(10000).capacityByScale, {});
});

// what the grok player reported playing the 4K Sched4 DCP on this laptop's CPU, one row per second at each scale
const SCHED4_MEASURED = {
  full: {
    capacity: [null, 13.0, 14.3, 17.4, 18.4, 18.3, 19.3, 19.2],
    shown: [null, 101.3, 6.1, 7.2, 8.0, 10.6, 13.6, 13.7],
    notDecoded: [0, 13, 23, 41, 51, 56, 60, 66],
  },
  half: {
    capacity: [46.7, 63.8, 79.0, 77.4, 77.9, 77.4, 77.3, 80.4],
    shown: [30.1, 23.4, 23.4, 23.4, 23.5, 23.5, 23.4, 23.5],
    notDecoded: [5, 5, 5, 5, 5, 5, 5, 5],
  },
  quarter: {
    capacity: [171.8, 217.8, 211.0, 207.5, 206.1, 206.7, 207.4, 213.6],
    shown: [24.7, 23.5, 23.4, 23.4, 23.5, 23.4, 23.4, 23.5],
    notDecoded: [3, 3, 3, 3, 3, 3, 3, 3],
  },
};

// the reading at a scale some time after the player started decoding at it, the last row repeating
function sched4Sample(scale, millisecondsAtScale, notDecodedBefore) {
  const rows = SCHED4_MEASURED[scale];
  const row = Math.min(Math.floor(millisecondsAtScale / 1000), rows.capacity.length - 1);
  return playing({
    decode_capacity_fps: rows.capacity[row],
    decoder_fps: rows.shown[row],
    dropped_frames_not_decoded: notDecodedBefore + rows.notDecoded[row],
  });
}

test('the measured 4K Sched4 readings settle at half and stay there', () => {
  let state = startPicker(0);
  let scaleSince = 0;
  let notDecodedBefore = 0;
  let lastNotDecoded = 0;
  const scales = [];
  for (let now = 0; now <= 120000; now += SAMPLE_INTERVAL_MS) {
    const sample = sched4Sample(state.scale, now - scaleSince, notDecodedBefore);
    lastNotDecoded = sample.dropped_frames_not_decoded;
    const scale = state.scale;
    state = nextPicker(state, sample, now);
    scales.push(state.scale);
    if (state.scale === scale) continue;
    scaleSince = now;
    notDecodedBefore = lastNotDecoded;
  }
  const firstHalf = scales.indexOf('half');
  assert.ok(firstHalf > 0, 'never stepped down from full');
  assert.ok(scales.slice(firstHalf).every((scale) => scale === 'half'), `left half: ${[...new Set(scales.slice(firstHalf))]}`);
});

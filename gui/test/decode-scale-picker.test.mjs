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

test('the scale never climbs back within a composition, whatever the capacity', () => {
  const samples = [...seconds(5.25, playing({ decoder_fps: 20 })), ...seconds(60, playing({ decode_capacity_fps: RATE * 40 }))];
  assert.equal(scalesOver(samples).scales.at(-1), 'half');
});

test('alternating behind and roomy stretches only ever step down, five seconds or more apart', () => {
  const samples = [];
  for (let round = 0; round < 6; round += 1) {
    samples.push(...seconds(5.5, playing({ decoder_fps: 20 })), ...seconds(10, playing({ decode_capacity_fps: RATE * 3 })));
  }
  const { scales } = scalesOver(samples);
  const changes = scales.flatMap((scale, index) => (index > 0 && scale !== scales[index - 1] ? [index] : []));
  assert.deepEqual(changes.map((index) => scales[index]), ['half', 'quarter']);
  assert.ok(changes[1] - changes[0] >= 5000 / SAMPLE_INTERVAL_MS, `steps ${changes} too close`);
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

// one row per second at each scale, the last repeating while the drop count rises by notDecodedPerSecond
function replay(measured, durationMs) {
  let state = startPicker(0);
  let scaleSince = 0;
  let notDecodedBefore = 0;
  const scales = [];
  for (let now = 0; now <= durationMs; now += SAMPLE_INTERVAL_MS) {
    const rows = measured[state.scale];
    const secondsAtScale = Math.floor((now - scaleSince) / 1000);
    const row = Math.min(secondsAtScale, rows.capacity.length - 1);
    const beyond = secondsAtScale - row;
    const dropped = notDecodedBefore + rows.notDecoded[row] + beyond * rows.notDecodedPerSecond;
    const sample = playing({ decode_capacity_fps: rows.capacity[row], decoder_fps: rows.shown[row], dropped_frames_not_decoded: dropped });
    const scale = state.scale;
    state = nextPicker(state, sample, now);
    scales.push(state.scale);
    if (state.scale === scale) continue;
    scaleSince = now;
    notDecodedBefore = dropped;
  }
  return scales;
}

const TWO_MINUTES_MS = 120000;

// the 4K Sched4 DCP on this laptop's CPU, the bare player with no window drawing
const SCHED4_BARE_PLAYER = {
  full: {
    capacity: [null, 13.0, 14.3, 17.4, 18.4, 18.3, 19.3, 19.2],
    shown: [null, 101.3, 6.1, 7.2, 8.0, 10.6, 13.6, 13.7],
    notDecoded: [0, 13, 23, 41, 51, 56, 60, 66],
    notDecodedPerSecond: 6,
  },
  half: {
    capacity: [46.7, 63.8, 79.0, 77.4, 77.9, 77.4, 77.3, 80.4],
    shown: [30.1, 23.4, 23.4, 23.4, 23.5, 23.5, 23.4, 23.5],
    notDecoded: [5, 5, 5, 5, 5, 5, 5, 5],
    notDecodedPerSecond: 0,
  },
  quarter: {
    capacity: [171.8, 217.8, 211.0, 207.5, 206.1, 206.7, 207.4, 213.6],
    shown: [24.7, 23.5, 23.4, 23.4, 23.5, 23.4, 23.4, 23.5],
    notDecoded: [3, 3, 3, 3, 3, 3, 3, 3],
    notDecodedPerSecond: 0,
  },
};

// the same DCP in the app under Xvfb, where software GL drawing halves the decode capacity
const SCHED4_IN_THE_APP = {
  full: {
    capacity: [null, 10.1, 11.5, 11.5],
    shown: [null, 17.2, 4.8, 5.8],
    notDecoded: [0, 12, 23, 40],
    notDecodedPerSecond: 10,
  },
  half: {
    capacity: [null, 39.8, 39.8, 39.5, 39.5, 39.4],
    shown: [26.3, 26.3, 27.1, 27.1, 27.1, 27.1],
    notDecoded: [0, 7, 13, 20, 27, 33],
    notDecodedPerSecond: 7,
  },
  quarter: {
    capacity: [null, 139.7, 171.5, 170.7],
    shown: [23.4, 23.4, 23.4, 23.5],
    notDecoded: [0, 0, 0, 0],
    notDecodedPerSecond: 0,
  },
};

function settlesAt(scales, expected) {
  const first = scales.indexOf(expected);
  assert.ok(first > 0, `never reached ${expected}: ${[...new Set(scales)]}`);
  assert.ok(scales.slice(first).every((scale) => scale === expected), `left ${expected}: ${[...new Set(scales.slice(first))]}`);
}

test('the bare player readings of the 4K Sched4 DCP settle at half and stay there', () => {
  settlesAt(replay(SCHED4_BARE_PLAYER, TWO_MINUTES_MS), 'half');
});

test('the in-app readings, where half falls behind with capacity to spare, settle at quarter and stay there', () => {
  settlesAt(replay(SCHED4_IN_THE_APP, TWO_MINUTES_MS), 'quarter');
});

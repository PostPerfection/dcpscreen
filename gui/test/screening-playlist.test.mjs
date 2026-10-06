import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IN_POINT,
  OUT_POINT,
  compositionLengths,
  formatCountdown,
  formatTimecode,
  frameAtPosition,
  parseTimecode,
  rangeFrameCount,
  rowLength,
  withRangePoint,
  holdCountdownText,
  newPlaylist,
  playlistHudText,
  rowTitle,
  runnerStatusText,
  warningText,
  withComposition,
  withIntermission,
  withRowMoved,
  withStartTime,
  withoutRow,
} from '../src/screening-playlist.js';

const FEATURE_PACKAGE = { directory: '/library/Feature' };
const FEATURE = { id: '7b2c0d64-5f3e-4c1a-9a57-0d3f1f6d2a10', title: 'Feature' };
const TRAILER_PACKAGE = { directory: '/library/Trailer' };
const TRAILER = { id: '1e0f4a2b-8c3d-4e5f-a6b7-c8d9e0f1a2b3', title: 'Trailer' };

function evening() {
  let playlist = newPlaylist('Evening');
  playlist = withComposition(playlist, TRAILER_PACKAGE, TRAILER);
  playlist = withIntermission(playlist, 300, null);
  return withComposition(playlist, FEATURE_PACKAGE, FEATURE);
}

test('rows are added in the shape the playlist file holds', () => {
  assert.deepEqual(evening(), {
    version: 2,
    name: 'Evening',
    rows: [
      { kind: 'composition', packageDirectory: '/library/Trailer', cplId: TRAILER.id, title: 'Trailer' },
      { kind: 'intermission', seconds: 300 },
      { kind: 'composition', packageDirectory: '/library/Feature', cplId: FEATURE.id, title: 'Feature' },
    ],
  });
  assert.deepEqual(withIntermission(newPlaylist('Still'), 60, '/stills/interval.png').rows, [
    { kind: 'intermission', seconds: 60, stillImage: '/stills/interval.png' },
  ]);
});

test('a row moves within the list and stays put at either end', () => {
  const playlist = evening();
  assert.deepEqual(withRowMoved(playlist, 2, -1).rows.map(rowTitle), ['Trailer', 'Feature', 'Intermission, 300 s of black']);
  assert.equal(withRowMoved(playlist, 0, -1), playlist);
  assert.equal(withRowMoved(playlist, 2, 1), playlist);
});

test('a row is removed by its index', () => {
  assert.deepEqual(withoutRow(evening(), 1).rows.map(rowTitle), ['Trailer', 'Feature']);
});

test('a start time is set and cleared on one row', () => {
  const scheduled = withStartTime(evening(), 2, '2026-10-06T20:30');
  assert.equal(scheduled.rows[2].startTime, '2026-10-06T20:30');
  assert.equal(scheduled.rows[0].startTime, undefined);
  assert.equal('startTime' in withStartTime(scheduled, 2, '').rows[2], false);
});

test('an intermission names what it holds', () => {
  assert.equal(rowTitle({ kind: 'intermission', seconds: 600, stillImage: '/stills/interval.png' }), 'Intermission, 600 s of still interval.png');
});

test('countdowns read as minutes and seconds, with hours when there are any', () => {
  assert.equal(formatCountdown(4.2), '0:05');
  assert.equal(formatCountdown(299), '4:59');
  assert.equal(formatCountdown(3725), '1:02:05');
  assert.equal(formatCountdown(-3), '0:00');
});

test('plan warnings read as sentences with row numbers from one', () => {
  assert.equal(
    warningText({ kind: 'startsBeforeItCan', row: 2, startTime: '2026-10-06T20:00:00', earliestStart: '2026-10-06T20:30:00' }),
    'Row 3 is set for 2026-10-06 20:00:00 but cannot start before 2026-10-06 20:30:00',
  );
  assert.equal(warningText({ kind: 'missingComposition', row: 0 }), 'Row 1: the composition is not in the library');
});

test('the HUD names the row on screen and what comes next and when', () => {
  const holding = {
    playlistName: 'Evening',
    activity: 'holding',
    currentTitle: 'Intermission, 300 s',
    nextTitle: 'Feature',
    secondsToNextStart: 61,
    errors: [],
  };
  assert.deepEqual(playlistHudText(holding), { current: 'Intermission, 300 s', next: 'Next: Feature' });
  assert.deepEqual(playlistHudText({ ...holding, currentTitle: null }), { current: 'Waiting', next: 'Next: Feature' });
  assert.deepEqual(playlistHudText({ ...holding, activity: 'playing' }), { current: 'Intermission, 300 s', next: 'Next: Feature in 1:01' });
  assert.deepEqual(playlistHudText({ ...holding, activity: 'playing', nextTitle: null }), { current: 'Intermission, 300 s', next: '' });
  assert.equal(playlistHudText({ ...holding, activity: 'finished' }), null);
  assert.equal(playlistHudText(null), null);
});

test('the runner status line carries the errors', () => {
  const finished = { playlistName: 'Evening', activity: 'finished', errors: ['row 1 (Trailer) skipped: no KDM fits'] };
  assert.equal(runnerStatusText(finished), 'Evening: finished. row 1 (Trailer) skipped: no KDM fits');
  assert.equal(runnerStatusText(null), 'Not playing');
  const playing = { playlistName: 'Evening', activity: 'playing', currentTitle: 'Trailer', nextTitle: 'Feature', secondsToNextStart: 90, errors: [] };
  assert.equal(runnerStatusText(playing), 'Evening: playing Trailer, next: Feature in 1:30');
  assert.equal(runnerStatusText({ ...playing, activity: 'holding' }), 'Evening: holding Trailer, next: Feature, 1:30 left');
});

test('a hold counts down in the transport, and nothing else does', () => {
  const holding = { playlistName: 'Evening', activity: 'holding', secondsToNextStart: 61, errors: [] };
  assert.equal(holdCountdownText(holding), '1:01 left');
  assert.equal(holdCountdownText({ ...holding, activity: 'playing' }), null);
  assert.equal(holdCountdownText(null), null);
});

test('timecode reads and writes frames at the composition rate', () => {
  assert.equal(formatTimecode(0, 24), '00:00:00:00');
  assert.equal(formatTimecode(89356, 24), '01:02:03:04');
  assert.equal(formatTimecode(1499, 25), '00:00:59:24');
  assert.equal(parseTimecode('01:02:03:04', 24), 89356);
  assert.equal(parseTimecode(' 00:00:59:24 ', 25), 1499);
  assert.equal(parseTimecode('', 24), null);
  assert.equal(parseTimecode(formatTimecode(123456, 48), 48), 123456);
});

test('a timecode that is not HH:MM:SS:FF inside the rate is refused', () => {
  for (const text of ['00:00:00:24', '00:60:00:00', '00:00:60:00', '1:02:03', 'tonight']) {
    assert.throws(() => parseTimecode(text, 24), /is not a timecode HH:MM:SS:FF at 24 frames a second/, text);
  }
});

test('in and out points are set and cleared one at a time, and the length follows them', () => {
  let playlist = evening();
  playlist = withRangePoint(playlist, 0, IN_POINT, 24);
  playlist = withRangePoint(playlist, 0, OUT_POINT, 72);
  assert.equal(playlist.rows[0].inFrame, 24);
  assert.equal(playlist.rows[0].outFrame, 72);
  assert.equal(rangeFrameCount(playlist.rows[0], 240), 48);

  playlist = withRangePoint(playlist, 0, IN_POINT, null);
  assert.equal('inFrame' in playlist.rows[0], false);
  assert.equal(rangeFrameCount(playlist.rows[0], 240), 72);
  assert.equal(rangeFrameCount(playlist.rows[2], 240), 240);
  assert.equal(rangeFrameCount(withRangePoint(playlist, 0, OUT_POINT, 480).rows[0], 240), 240);
});

test('the frame on screen counts from the in frame the row was loaded with', () => {
  assert.equal(frameAtPosition({ kind: 'composition', inFrame: 240 }, 2.5, 24), 300);
  assert.equal(frameAtPosition({ kind: 'composition' }, 2.5, 24), 60);
});

test('a row finds its frame count and rate in the library listing', () => {
  const lengths = compositionLengths([
    { directory: '/library/Trailer', compositions: [{ id: TRAILER.id, durationFrames: 3600, editRate: [25, 1] }] },
  ]);
  const [trailer, intermission, feature] = evening().rows;
  assert.deepEqual(rowLength(lengths, trailer), { frameCount: 3600, framesPerSecond: 25 });
  assert.equal(rowLength(lengths, intermission), undefined);
  assert.equal(rowLength(lengths, feature), undefined);
});

test('a range outside the composition reads as a sentence', () => {
  assert.equal(
    warningText({ kind: 'rangeOutsideComposition', row: 0, inFrame: 216, outFrame: 480, frameCount: 240 }),
    'Row 1: frames 216 to 480 are not inside the composition, which is 240 frames long',
  );
});

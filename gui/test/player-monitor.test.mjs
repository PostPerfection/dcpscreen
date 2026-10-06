import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorForPlayer, playerMonitorChoices } from '../src/player-monitor.js';

const LAPTOP = { name: 'eDP-1', size: { width: 2880, height: 1800 }, position: { x: 0, y: 0 } };
const PROJECTOR = { name: 'HDMI-1', size: { width: 4096, height: 2160 }, position: { x: 2880, y: 0 } };
const UNNAMED = { name: null, size: { width: 1920, height: 1080 }, position: { x: 6976, y: 0 } };

test('the saved monitor is chosen while it is connected', () => {
  assert.equal(monitorForPlayer([LAPTOP, PROJECTOR], 'HDMI-1', LAPTOP), PROJECTOR);
});

test('a saved monitor that is not connected falls back to the main window monitor', () => {
  assert.equal(monitorForPlayer([LAPTOP], 'HDMI-1', LAPTOP), LAPTOP);
});

test('no saved monitor plays on the main window monitor, even next to an unnamed one', () => {
  assert.equal(monitorForPlayer([UNNAMED, PROJECTOR], null, PROJECTOR), PROJECTOR);
});

test('the choices list connected monitors with their size and skip unnamed ones', () => {
  assert.deepEqual(playerMonitorChoices([LAPTOP, UNNAMED, PROJECTOR], 'HDMI-1'), [
    { name: 'eDP-1', label: 'eDP-1 (2880x1800)' },
    { name: 'HDMI-1', label: 'HDMI-1 (4096x2160)' },
  ]);
});

test('a saved monitor that is not connected stays a choice, marked as such', () => {
  assert.deepEqual(playerMonitorChoices([LAPTOP], 'HDMI-1'), [
    { name: 'eDP-1', label: 'eDP-1 (2880x1800)' },
    { name: 'HDMI-1', label: 'HDMI-1 (not connected)' },
  ]);
});

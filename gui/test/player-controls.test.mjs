import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayProfileChoices,
  playerControlCommands,
  playerControlsFromFields,
  playerWarningText,
  soundDeviceChoices,
} from '../src/player-controls.js';

const FIELDS = {
  brightness: '1.5',
  maskTop: '5',
  maskBottom: '5',
  maskLeft: '0',
  maskRight: '2.5',
  scaling: 'fill',
  soundDevice: '',
  soundLayout: 'fivePointOne',
  soundDelayMilliseconds: '-40',
  subtitleOffsetPercent: '4',
  subtitleColourOverridden: false,
  subtitleColour: '#ffcc00',
  displayProfile: '/profiles/booth.icc',
};

const CONTROLS = playerControlsFromFields(FIELDS);

test('the form fields become the settings the backend reads', () => {
  assert.deepEqual(CONTROLS, {
    playerPicture: { brightness: 1.5, masksPercent: { top: 5, bottom: 5, left: 0, right: 2.5 }, scaling: 'fill' },
    playerSound: { device: null, layout: 'fivePointOne', delayMilliseconds: -40 },
    playerSubtitles: { offsetPercent: 4, colour: null },
    playerDisplayProfile: '/profiles/booth.icc',
  });
  assert.equal(playerControlsFromFields({ ...FIELDS, displayProfile: '' }).playerDisplayProfile, null);
});

test('the subtitle colour is only kept while the override is ticked', () => {
  const overridden = playerControlsFromFields({ ...FIELDS, subtitleColourOverridden: true });
  assert.equal(overridden.playerSubtitles.colour, '#ffcc00');
});

test('with nothing applied yet every control is sent', () => {
  assert.deepEqual(
    playerControlCommands(null, CONTROLS).map(([command]) => command),
    [
      'preview_set_picture',
      'preview_set_sound_device',
      'preview_set_sound_layout',
      'preview_set_sound_delay',
      'preview_set_subtitle_presentation',
      'preview_set_display_profile',
    ],
  );
});

test('a changed monitor profile is sent on its own, and clearing it sends null', () => {
  const cleared = playerControlsFromFields({ ...FIELDS, displayProfile: '' });
  assert.deepEqual(playerControlCommands(CONTROLS, cleared), [['preview_set_display_profile', { profile: null }]]);
});

test('colord profiles are listed by file name', () => {
  assert.deepEqual(displayProfileChoices(['/home/booth/.local/share/icc/edid-ee14.icc']), [
    { path: '/home/booth/.local/share/icc/edid-ee14.icc', label: 'edid-ee14.icc' },
  ]);
});

test('only the controls that changed are sent, so the sound is not reopened for a brightness change', () => {
  const brighter = playerControlsFromFields({ ...FIELDS, brightness: '2' });
  assert.deepEqual(playerControlCommands(CONTROLS, brighter), [
    ['preview_set_picture', { picture: brighter.playerPicture }],
  ]);
  assert.deepEqual(playerControlCommands(CONTROLS, CONTROLS), []);
});

test('a later sound delay is sent on its own', () => {
  const later = playerControlsFromFields({ ...FIELDS, soundDelayMilliseconds: '120' });
  assert.deepEqual(playerControlCommands(CONTROLS, later), [['preview_set_sound_delay', { milliseconds: 120 }]]);
});

test('a saved sound device that is gone stays a choice, marked as such', () => {
  assert.deepEqual(soundDeviceChoices(['default', 'HDMI'], 'USB DAC'), [
    { name: 'default', label: 'default' },
    { name: 'HDMI', label: 'HDMI' },
    { name: 'USB DAC', label: 'USB DAC (not connected)' },
  ]);
  assert.deepEqual(soundDeviceChoices(['HDMI'], null), [{ name: 'HDMI', label: 'HDMI' }]);
});

test('warnings read as one status line, none as nothing', () => {
  assert.equal(playerWarningText([]), null);
  assert.equal(playerWarningText(undefined), null);
  assert.equal(
    playerWarningText(['output device X is missing, sound plays on the default device', 'the device has no 7.1']),
    'Player: output device X is missing, sound plays on the default device. the device has no 7.1',
  );
});

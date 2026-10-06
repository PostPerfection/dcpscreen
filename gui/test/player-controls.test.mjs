import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayProfileChoices,
  fillPlayerControlFields,
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
  stereo: 'sideBySide',
  decodeResolution: 'automatic',
};

const CONTROLS = playerControlsFromFields(FIELDS);

test('the form fields become the settings the backend reads', () => {
  assert.deepEqual(CONTROLS, {
    playerPicture: { brightness: 1.5, masksPercent: { top: 5, bottom: 5, left: 0, right: 2.5 }, scaling: 'fill' },
    playerSound: { device: null, layout: 'fivePointOne', delayMilliseconds: -40 },
    playerSubtitles: { offsetPercent: 4, colour: null },
    playerDisplayProfile: '/profiles/booth.icc',
    playerStereo: 'sideBySide',
    decodeResolution: 'automatic',
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
      'preview_set_stereo_output',
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

function fakeField() {
  return {
    value: '',
    checked: false,
    textContent: '',
    hidden: true,
    options: [],
    replaceChildren(...options) {
      this.options = options;
    },
  };
}

function fakeFields() {
  const names = ['displayProfile', 'brightness', 'maskTop', 'maskBottom', 'maskLeft', 'maskRight', 'scaling',
    'soundDevice', 'soundDeviceError', 'soundLayout', 'soundDelayMilliseconds', 'subtitleOffsetPercent',
    'subtitleColourOverridden', 'subtitleColour', 'stereo', 'decodeResolution'];
  return Object.fromEntries(names.map((name) => [name, fakeField()]));
}

const SAVED = {
  playerPicture: { brightness: 1.5, masksPercent: { top: 5, bottom: 5, left: 0, right: 2.5 }, scaling: 'fill' },
  playerSound: { device: 'HDMI 1', layout: 'fivePointOne', delayMilliseconds: -40 },
  playerSubtitles: { offsetPercent: 4, colour: '#ffcc00' },
  playerDisplayProfile: '/profiles/booth.icc',
  playerStereo: 'topAndBottom',
  decodeResolution: 'half',
};
const makeOption = (value, text) => ({ value, text });

test('a sound device list that fails still fills every field and says why under the device', async () => {
  const fields = fakeFields();

  await fillPlayerControlFields(fields, SAVED, {
    listSoundDevices: async () => { throw new Error('ALSA function snd_device_name_hint failed'); },
    makeOption,
  });

  assert.equal(fields.displayProfile.value, '/profiles/booth.icc');
  assert.equal(fields.brightness.value, 1.5);
  assert.equal(fields.maskRight.value, 2.5);
  assert.equal(fields.scaling.value, 'fill');
  assert.equal(fields.soundLayout.value, 'fivePointOne');
  assert.equal(fields.soundDelayMilliseconds.value, -40);
  assert.equal(fields.subtitleOffsetPercent.value, 4);
  assert.equal(fields.subtitleColourOverridden.checked, true);
  assert.equal(fields.subtitleColour.value, '#ffcc00');
  assert.equal(fields.stereo.value, 'topAndBottom');
  assert.equal(fields.decodeResolution.value, 'half');
  assert.equal(fields.soundDevice.value, 'HDMI 1');
  assert.deepEqual(fields.soundDevice.options.map((option) => option.value), ['', 'HDMI 1']);
  assert.equal(fields.soundDeviceError.hidden, false);
  assert.equal(
    fields.soundDeviceError.textContent,
    'The sound devices could not be listed: Error: ALSA function snd_device_name_hint failed',
  );
});

test('a sound device list that works fills the choices and hides the error', async () => {
  const fields = fakeFields();
  fields.soundDeviceError.hidden = false;

  await fillPlayerControlFields(fields, SAVED, { listSoundDevices: async () => ['HDMI 1', 'Speakers'], makeOption });

  assert.deepEqual(fields.soundDevice.options.map((option) => option.value), ['', 'HDMI 1', 'Speakers']);
  assert.equal(fields.soundDeviceError.hidden, true);
});

test('a changed 3D output is sent on its own', () => {
  const topAndBottom = playerControlsFromFields({ ...FIELDS, stereo: 'topAndBottom' });
  assert.deepEqual(playerControlCommands(CONTROLS, topAndBottom), [['preview_set_stereo_output', { output: 'topAndBottom' }]]);
});

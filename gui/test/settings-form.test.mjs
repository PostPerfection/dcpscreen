import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsFromFields, withLibraryRoot, withoutLibraryRoot } from '../src/settings-form.js';

test('empty recipient, GPU and player monitor fields are saved as unset', () => {
  assert.deepEqual(
    settingsFromFields({
      libraryRoots: ['/srv/dcp'],
      recipientCertificate: '',
      recipientKey: '/keys/leaf.key',
      gpu: true,
      gpuLicense: '',
      gpuRegistrationUrl: 'https://licence.example/register',
      playerMonitor: '',
      playerFullscreen: false,
    }),
    {
      libraryRoots: ['/srv/dcp'],
      recipientCertificate: null,
      recipientKey: '/keys/leaf.key',
      gpu: true,
      gpuLicense: null,
      gpuRegistrationUrl: 'https://licence.example/register',
      playerMonitor: null,
      playerFullscreen: false,
    },
  );
});

test('a folder already listed is not added twice', () => {
  assert.deepEqual(withLibraryRoot(['/srv/dcp'], '/srv/dcp'), ['/srv/dcp']);
  assert.deepEqual(withLibraryRoot(['/srv/dcp'], '/mnt/ingest'), ['/srv/dcp', '/mnt/ingest']);
});

test('removing a folder drops only the one at that index', () => {
  assert.deepEqual(withoutLibraryRoot(['/a', '/b', '/c'], 1), ['/a', '/c']);
});

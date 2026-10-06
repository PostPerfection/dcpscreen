import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playRefusalText } from '../src/play-refusal.js';

test('each stored KDM is named by file with its fit', () => {
  const kdms = [
    { path: '/data/kdms/a_expired.xml', fit: 'Expired' },
    { path: '/data/kdms/b_other.xml', fit: 'WrongRecipient' },
  ];
  assert.equal(
    playRefusalText('Trailer', kdms),
    'No KDM opens Trailer now.\na_expired.xml: Expired\nb_other.xml: WrongRecipient',
  );
});

test('a composition with no stored KDM says so', () => {
  assert.equal(playRefusalText('Trailer', []), 'Keys holds no KDM for Trailer.');
});

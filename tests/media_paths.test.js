'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveMediaAbsolutePath } = require('../app/main/ipc/media-paths');

const roots = {
  botImagesPath: path.resolve('C:/app/bot/files'),
  botFilesPath: path.resolve('C:/app/bot/files'),
};

test('resolveMediaAbsolutePath resolves known media categories', () => {
  const out = resolveMediaAbsolutePath(roots, 'backgrounds/cafe.png');
  assert.equal(out, path.resolve('C:/app/bot/files/backgrounds/cafe.png'));
});

test('resolveMediaAbsolutePath blocks traversal attempts', () => {
  const out = resolveMediaAbsolutePath(roots, '../secrets.txt');
  assert.equal(out, null);
});

test('resolveMediaAbsolutePath blocks unknown roots', () => {
  const out = resolveMediaAbsolutePath(roots, 'config/config.json');
  assert.equal(out, null);
});

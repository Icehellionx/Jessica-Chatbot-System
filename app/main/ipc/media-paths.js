'use strict';

const path = require('path');

function resolveMediaAbsolutePath({ botImagesPath, botFilesPath }, relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return null;
  }

  const rootKey = normalized.split('/')[0];
  let baseDir = null;

  if (rootKey === 'backgrounds' || rootKey === 'splash' || rootKey === 'music' || rootKey === 'sprites') {
    baseDir = botImagesPath;
  } else if (rootKey === 'characters') {
    baseDir = botFilesPath;
  }

  if (!baseDir) return null;

  const baseResolved = path.resolve(baseDir);
  const fullResolved = path.resolve(baseDir, normalized);
  if (!fullResolved.startsWith(baseResolved + path.sep) && fullResolved !== baseResolved) {
    return null;
  }
  return fullResolved;
}

module.exports = { resolveMediaAbsolutePath };

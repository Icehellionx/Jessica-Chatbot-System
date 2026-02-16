'use strict';

function sanitizeFilename(name) {
  return String(name ?? '')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase()
    .slice(0, 80) || 'chat';
}

module.exports = { sanitizeFilename };

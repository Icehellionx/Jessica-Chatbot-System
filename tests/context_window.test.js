'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyContextWindow, estimateTokensFromMessageContent } = require('../ipc/context-window');

test('estimateTokensFromMessageContent handles text and multipart content', () => {
  assert.equal(estimateTokensFromMessageContent('abcd'), 1);
  assert.equal(
    estimateTokensFromMessageContent([
      { type: 'text', text: 'abcdefgh' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]),
    52
  );
});

test('applyContextWindow preserves system message and appends suffix', () => {
  const out = applyContextWindow(
    [
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi' },
    ],
    { maxContext: 4096, systemSuffix: '\n[extra rules]' }
  );

  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /base system/);
  assert.match(out[0].content, /\[extra rules\]/);
});

test('applyContextWindow drops older history when context is tight', () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(400) });
  }

  const out = applyContextWindow(msgs, { maxContext: 1600, systemSuffix: '\n[sfx]' });
  const nonSystem = out.filter((m) => m.role !== 'system');

  assert.ok(nonSystem.length < 20);
  assert.ok(nonSystem.length > 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../app/main/ai_services');

test('buildChatCompletionsBody sets expected OpenAI-compatible fields', () => {
  const body = __private.buildChatCompletionsBody(
    [{ role: 'user', content: 'Hi' }],
    { model: 'gpt-test', temperature: 0.2, maxTokens: 123, stream: true }
  );

  assert.equal(body.model, 'gpt-test');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 123);
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 1);
});

test('buildGeminiBody maps system message and inline image data', () => {
  const body = __private.buildGeminiBody(
    [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,Zm9v' } },
        ],
      },
    ],
    { maxTokens: 64, temperature: 0.6 }
  );

  assert.equal(body.systemInstruction.parts[0].text, 'You are helpful.');
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].parts[0].text, 'describe this');
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(body.contents[0].parts[1].inlineData.data, 'Zm9v');
  assert.equal(body.generationConfig.maxOutputTokens, 64);
  assert.equal(body.generationConfig.temperature, 0.6);
});

test('createOpenAISSEParser recovers tokens across split chunks', () => {
  const tokens = [];
  const parser = __private.createOpenAISSEParser((t) => tokens.push(t));

  parser('data: {"choices":[{"delta":{"content":"Hel');
  parser('lo"}}]}\n');
  parser('data: {"choices":[{"delta":{"content":" world"}}]}\n');
  parser('data: [DONE]\n');

  assert.deepEqual(tokens, ['Hello', ' world']);
});

test('parseFirstJsonObject parses array payloads with preamble text', () => {
  const parsed = __private.parseFirstJsonObject('Result:\n["opt1","opt2"]');
  assert.deepEqual(parsed, ['opt1', 'opt2']);
});

test('parseFirstJsonObject still parses object payloads', () => {
  const parsed = __private.parseFirstJsonObject('debug {"score":88,"status":"Good"} tail');
  assert.deepEqual(parsed, { score: 88, status: 'Good' });
});

'use strict';

const { parsePlainReply } = require('./phone-domain');

async function generatePhoneReply({ aiService, config, characterName, thread, readTextSafe, botFilesPath, path }) {
  const personalityPath = path.join(botFilesPath, 'characters', characterName, 'personality.txt');
  readTextSafe(personalityPath, '').slice(0, 2400);
  const transcript = thread.messages.slice(-16).map((m) => `${m.from}: ${m.text}`).join('\n');

  const response = await aiService.generateCompletion(config, [
    {
      role: 'system',
      content:
`You are ${characterName} in a phone text thread.
Rules:
1) Reply as ${characterName} only.
2) Keep to 1-2 short text-message sentences.
3) No scene tags, no narration, no markdown.
4) Do not reveal private messages from other threads.
5) If uncertain, ask a concise clarifying question.`,
    },
    {
      role: 'user',
      content:
`Participants: ${thread.participants.join(', ')}
Recent thread:
${transcript}

Write ${characterName}'s next text message.`,
    },
  ], {
    temperature: 0.65,
    max_tokens: 120,
    useUtility: true,
  });

  return parsePlainReply(response);
}

async function generateInboundText({
  aiService,
  config,
  from,
  thread,
  readTextSafe,
  botFilesPath,
  path,
  topicHint,
}) {
  const personalityPath = path.join(botFilesPath, 'characters', from, 'personality.txt');
  readTextSafe(personalityPath, '').slice(0, 2400);
  const transcript = thread.messages.slice(-16).map((m) => `${m.from}: ${m.text}`).join('\n');
  const response = await aiService.generateCompletion(config, [
    {
      role: 'system',
      content:
`You are ${from} texting first in an ongoing phone thread.
Rules:
1) Write exactly one short text (1-2 sentences).
2) No scene tags, no markdown, no narration.
3) Keep it plausible for a normal text message.
4) Preserve privacy: do not mention content from other threads.`,
    },
    {
      role: 'user',
      content:
`Participants: ${thread.participants.join(', ')}
Recent thread:
${transcript || '(empty)'}
${topicHint ? `\nTopic hint: ${topicHint}` : ''}

Write ${from}'s next inbound text.`,
    },
  ], { useUtility: true, temperature: 0.7, max_tokens: 90 });

  return parsePlainReply(response);
}

module.exports = {
  generatePhoneReply,
  generateInboundText,
};

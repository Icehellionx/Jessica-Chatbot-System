'use strict';

const fs = require('fs');
const path = require('path');

let embeddedState = null; // { llama, model, context, LlamaChatSession, modelName }

function findEmbeddedModelPath(modelName) {
  const candidates = [
    path.join(process.resourcesPath || '', 'models', modelName),
    path.join(process.cwd(), 'bot', 'models', modelName),
    path.join(process.cwd(), 'models', modelName),
    modelName,
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function getEmbeddedLlamaState(modelName) {
  if (embeddedState && embeddedState.modelName === modelName) return embeddedState;

  const modelPath = findEmbeddedModelPath(modelName);
  if (!modelPath) {
    throw new Error(`Embedded model file "${modelName}" not found. Please place it in bot/models/`);
  }

  try {
    const nll = await import('node-llama-cpp');
    const llama = await nll.getLlama();

    console.log('[AI] Loading embedded model from:', modelPath);
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();

    embeddedState = {
      llama,
      model,
      context,
      LlamaChatSession: nll.LlamaChatSession,
      modelName,
    };
    return embeddedState;
  } catch (e) {
    console.error('[AI] Failed to load node-llama-cpp:', e);
    throw new Error('Failed to load embedded AI engine. Is "node-llama-cpp" installed?');
  }
}

async function generateEmbeddedCompletion(settings, messages, options = {}) {
  const { context, LlamaChatSession } = await getEmbeddedLlamaState(settings.model);
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });

  const history = messages.slice(0, -1).map((m) => ({
    type: m.role === 'assistant' ? 'model' : m.role,
    text: m.content,
  }));

  session.setChatHistory(history);

  const lastMsg = messages[messages.length - 1];
  const response = await session.prompt(lastMsg.content, {
    maxTokens: options.max_tokens,
    temperature: options.temperature,
  });

  return response;
}

module.exports = {
  findEmbeddedModelPath,
  getEmbeddedLlamaState,
  generateEmbeddedCompletion,
};

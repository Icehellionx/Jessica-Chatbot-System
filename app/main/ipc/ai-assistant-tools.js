'use strict';

function createAssistantTools({ generateCompletion, parseFirstJsonObject }) {
  async function generateReplySuggestions(config, messages) {
    const recent = messages.slice(-5);
    const systemPrompt = `You are a Roleplay Assistant.
Read the conversation and generate 3 distinct, short reply options for the User.
1. Positive/Agreeable
2. Negative/Conflict
3. Creative/Unexpected

Output format: JSON array of strings. Example: ["Ask about her day", "Ignore her", "Offer a drink"]
Keep them under 10 words. Output ONLY the JSON array.`;

    const payload = [
      { role: 'system', content: systemPrompt },
      ...recent
    ];

    try {
      const text = await generateCompletion(config, payload, { temperature: 0.7, max_tokens: 100, useUtility: true });
      const parsed = parseFirstJsonObject(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  async function generateChapterTitle(config, messages) {
    const recent = messages.slice(-10);
    const systemPrompt = `Summarize the current scene in 3-6 words for a Save File title.
Examples: "Meeting at the Cafe", "The Argument", "Late Night Confession".
Output ONLY the title. No quotes.`;

    const payload = [
      { role: 'system', content: systemPrompt },
      ...recent
    ];

    try {
      const text = await generateCompletion(config, payload, { temperature: 0.3, max_tokens: 20, useUtility: true });
      return text ? text.trim().replace(/["']/g, '') : 'New Chapter';
    } catch (e) {
      return 'New Chapter';
    }
  }

  async function summarizeChat(config, textToSummarize, previousSummary = '') {
    const systemPrompt = `You are a Scribe. Summarize the following conversation events concisely to append to a history log.
Previous Context: ${previousSummary || 'None'}`;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: textToSummarize }];
    return generateCompletion(config, messages, { temperature: 0.3, max_tokens: 300, useUtility: true });
  }

  async function generateQuestObjective(config, messages) {
    const recent = messages.slice(-10);
    const systemPrompt = `You are a Game Master. Analyze the conversation and define the current objective for the player.
Examples: "Find out why she is crying", "Escape the building", "Ask her on a date", "Survive the interrogation".
Output ONLY the objective text. Keep it under 10 words. If no clear objective, output "Chat with the character".`;

    const payload = [
      { role: 'system', content: systemPrompt },
      ...recent
    ];

    try {
      const text = await generateCompletion(config, payload, { temperature: 0.3, max_tokens: 30, useUtility: true });
      return text ? text.trim().replace(/^Objective:\s*/i, '').replace(/["']/g, '') : 'Explore the story';
    } catch (e) {
      return 'Explore the story';
    }
  }

  async function analyzeAffinity(config, messages, charName) {
    const recent = messages.slice(-10);
    const systemPrompt = `You are a Relationship Tracker.
Analyze the relationship between the User and "${charName}" based on the recent conversation.
Output a JSON object: {"score": number (0-100), "status": string (e.g. "Strangers", "Friends", "Flirty", "Hostile", "Lovers")}.
Base the score on trust, intimacy, and positive interactions.`;

    const payload = [
      { role: 'system', content: systemPrompt },
      ...recent
    ];

    try {
      const text = await generateCompletion(config, payload, { temperature: 0.1, max_tokens: 60, useUtility: true });
      const parsed = parseFirstJsonObject(text);
      return parsed || { score: 50, status: 'Neutral' };
    } catch (e) {
      return { score: 50, status: 'Neutral' };
    }
  }

  return {
    generateReplySuggestions,
    generateChapterTitle,
    summarizeChat,
    generateQuestObjective,
    analyzeAffinity,
  };
}

module.exports = { createAssistantTools };

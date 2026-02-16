'use strict';

function createStoryTools({ generateCompletion, parseFirstJsonObject, parseTagLines }) {
  async function cleanupResponse(config, text) {
    if (!text || !/[\[\]]/.test(text)) return text;

    const systemPrompt = `You are a Copy Editor.
Your task is to remove any malformed, incomplete, or leftover system tags from the text.
Examples of artifacts to remove:
- "[BG: ...]"
- "[SPRITE: ...]"
- "[SCENE_STATE: ...]"
- "[/SCENE]"
- Broken tags like "Danny]" or "[ "

Rules:
1. Preserve all dialogue and narration exactly as is.
2. Remove ANY bracketed content that looks like a system command, debug info, or metadata.
3. Output ONLY the cleaned text. Do NOT include introductions like "Here is the cleaned text".`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ];

    try {
      let cleaned = await generateCompletion(config, messages, { temperature: 0.1, max_tokens: Math.max(200, text.length), useUtility: true });
      if (cleaned) {
        cleaned = cleaned.replace(/^(Here is|Here's) the (cleaned|corrected) text:?\s*/i, '').replace(/^Cleaned text:?\s*/i, '').replace(/^Output:?\s*/i, '');
      }

      if (!cleaned || cleaned.length < text.length * 0.5) return text;
      return cleaned.trim();
    } catch (e) {
      return text;
    }
  }

  async function extractUserFacts(config, messages) {
    const recent = messages.slice(-4);
    const systemPrompt = `You are a Memory System.
Analyze the dialogue and extract new, permanent facts about the User (e.g. name, job, likes, dislikes, history).
Ignore trivial events or current actions.
Output a JSON array of objects formatted for a Lorebook:
[
  { "entry": "User is a doctor.", "keywords": ["user", "job", "doctor"] },
  { "entry": "User hates spiders.", "keywords": ["user", "phobia", "spiders"] }
]
If no new facts, output [].`;

    const payload = [
      { role: 'system', content: systemPrompt },
      ...recent
    ];

    try {
      const text = await generateCompletion(config, payload, { temperature: 0.1, max_tokens: 150, useUtility: true });
      const parsed = parseFirstJsonObject(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  async function expandImagePrompt(config, shortDescription) {
    const normalizedInput = String(shortDescription || '').replace(/[_-]+/g, ' ').trim();
    if (!normalizedInput) return shortDescription;

    const systemPrompt = `You are an AI Art Prompt Engineer.
Expand a short scene description into a detailed background-image prompt for a visual novel.
Rules:
1. Preserve the original setting and key nouns from the input.
2. Do NOT replace the location with a different one.
3. Keep "no characters".
4. Avoid graphic violence/horror wording; keep it scenic and safe.
5. Output a single prompt line only.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: normalizedInput }
    ];

    const text = await generateCompletion(config, messages, { temperature: 0.35, max_tokens: 120, useUtility: true });
    let out = text ? text.trim().replace(/^Output:\s*/i, '').replace(/"/g, '') : normalizedInput;

    const lowerOut = out.toLowerCase();
    const keyTerms = normalizedInput.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
    if (keyTerms.length && !keyTerms.some((k) => lowerOut.includes(k))) {
      out = `${normalizedInput}, ${out}`;
    }
    return out;
  }

  async function findClosestSprite(config, request, availableFiles) {
    const systemPrompt = `You are a File Matcher.
Pick the filename that best matches the requested emotion/description.
Request: "${request}"
Files: ${JSON.stringify(availableFiles)}
Output ONLY the exact filename from the list. If nothing fits well, output "none".`;

    const messages = [{ role: 'system', content: systemPrompt }];

    try {
      const text = await generateCompletion(config, messages, { temperature: 0.1, max_tokens: 50, useUtility: true });
      return text ? text.trim().replace(/['"]/g, '') : null;
    } catch (e) {
      return null;
    }
  }

  async function determineActiveContext(config, messages, candidates) {
    const recent = messages.slice(-4);
    const systemPrompt = `You are a Context Librarian.
Select the most relevant items from the list below that are needed for the current conversation context.
Candidates: ${JSON.stringify(candidates)}

Output a JSON array of strings containing ONLY the relevant items.
If nothing is relevant, output [].`;

    const payload = [
      { role: 'system', content: systemPrompt },
      ...recent
    ];

    try {
      const text = await generateCompletion(config, payload, { temperature: 0.1, max_tokens: 150, useUtility: true });
      const parsed = parseFirstJsonObject(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  async function generateDynamicEvent(config, options = {}) {
    const { messages, currentBackground, activeCharacters } = options;
    const recentMessages = messages.slice(-4).map((m) => `${m.role}: ${m.content}`).join('\n');

    const systemPrompt = `You are a creative event director for a visual novel. The conversation has stalled.
Your task is to introduce a new, small-scale event to move the story forward.
The event should be a single, self-contained paragraph of narration.
It can introduce a new minor character, a sound, a change in the environment, or a character action.
Keep it concise and relevant to the current scene.

CURRENT SCENE:
- Background: "${currentBackground}"
- Characters Present: ${activeCharacters.join(', ') || 'None'}
- Recent Conversation:
---
${recentMessages}
---

Rules:
1.  Write a single paragraph of narrative text describing the event.
2.  The text can include visual tags like [SPRITE: Name/emotion], [SFX: sound_name], or [BG: new_background].
3.  Do NOT write dialogue for the main characters. The event should be something they react to.
4.  The tone should be consistent with a realistic, modern-day setting. Avoid high fantasy or sci-fi unless the context supports it.

Example Output:
"A sudden downpour begins outside, and the sound of heavy rain patters against the cafe windows. [SFX: rain_loop] A moment later, the bell on the door jingles and a soaking wet young man, looking flustered, rushes inside, shaking out his umbrella. [SPRITE: Jake/anxious]"

Now, generate a new event based on the current scene.`;

    const payload = [{ role: 'system', content: systemPrompt }];

    try {
      const response = await generateCompletion(config, payload, { temperature: 0.75, max_tokens: 200, useUtility: true });
      return response;
    } catch (e) {
      console.error('Dynamic event generation failed:', e);
      return null;
    }
  }

  async function reviewVisuals(config, options = {}) {
    const {
      messages,
      currentBackground,
      activeCharacters,
      availableBackgrounds,
      availableSprites
    } = options;

    const recentMessages = messages.slice(-3).map((m) => `${m.role}: ${m.content}`).join('\n');

    const systemPrompt = `You are a visual novel quality assurance director. Your job is to ensure the scene's visuals are logical based on the most recent dialogue.
Review the current state and the recent messages.
If the visuals are illogical, output a list of [TAGS] to correct the scene.
For example, if a character leaves but their sprite is still visible, you should output "[HIDE: CharacterName]".
If the dialogue mentions a "dark forest" but the background is a "sunny cafe", you should output "[BG: forest_night]".
If a character is described as "crying" but their sprite is "happy", you should output "[SPRITE: CharacterName/sad]".

CURRENT STATE:
- Background: "${currentBackground}"
- Active Characters: ${activeCharacters.length > 0 ? activeCharacters.join(', ') : 'None'}

RECENT DIALOGUE:
---
${recentMessages}
---

AVAILABLE ASSETS:
- Backgrounds: ${availableBackgrounds.join(', ')}
- Character Sprites: ${availableSprites.join(', ')}

Output ONLY the [TAGS] needed for correction, one per line. If no corrections are needed, output nothing.`;

    const payload = [{ role: 'system', content: systemPrompt }];

    try {
      const response = await generateCompletion(config, payload, { temperature: 0.2, max_tokens: 150, useUtility: true });
      return response ? parseTagLines(response) : null;
    } catch (e) {
      console.error('Visual review failed:', e);
      return null;
    }
  }

  return {
    cleanupResponse,
    extractUserFacts,
    expandImagePrompt,
    findClosestSprite,
    determineActiveContext,
    generateDynamicEvent,
    reviewVisuals,
  };
}

module.exports = { createStoryTools };

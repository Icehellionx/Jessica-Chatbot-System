'use strict';

function createInnerMonologueTool({ generateCompletion }) {
  async function fetchInnerMonologue(config, characterName, messages, personality = '') {
    const stripSceneArtifacts = (text) => String(text || '')
      .replace(/\[SCENE\][\s\S]*?\[\/SCENE\]/gi, ' ')
      .replace(/\[SCENE_STATE:[^\]]*\]/gi, ' ')
      .replace(/\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):[^\]]*\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const systemPrompt = `You are a world-class author. Based on the provided conversation history, write a short, first-person inner monologue EXCLUSIVELY for the character "${characterName}".
${personality ? `\n[CHARACTER PROFILE]\n${personality}\n` : ''}
- You are "${characterName}". Speak in the first person ("I").
- Do NOT write thoughts for any other character.
- The monologue should reveal your private thoughts, feelings, or intentions based on the recent events.
- Write ONLY the monologue text itself.
- Do NOT include any surrounding text, narration, or quotation marks.
- Do NOT output scene tags, speaker names, stage directions, or choice menus.
- The tone should match your personality and the current situation.`;

    const recentMessages = (Array.isArray(messages) ? messages : [])
      .slice(-10)
      .map((m) => ({
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        content: stripSceneArtifacts(m?.content),
      }))
      .filter((m) => m.content);

    const transcript = recentMessages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const finalMessages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
`Conversation history:
${transcript || '(No prior context.)'}

Now write ${characterName}'s private internal thoughts in 2-4 sentences.`,
      },
    ];

    try {
      const monologue = await generateCompletion(config, finalMessages, {
        temperature: 0.35,
        max_tokens: 140,
        useUtility: true,
      });
      return String(monologue || '')
        .replace(/\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT|SCENE_STATE):[^\]]*\]/gi, ' ')
        .replace(/^\s*[A-Za-z0-9 _-]{1,40}:\s*/g, '')
        .trim();
    } catch (e) {
      console.error('Inner Monologue generation failed:', e);
      return 'Failed to generate thoughts.';
    }
  }

  return { fetchInnerMonologue };
}

module.exports = { createInnerMonologueTool };

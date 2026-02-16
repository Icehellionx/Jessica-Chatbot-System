'use strict';

function createSceneTools({ generateCompletion, parseFirstJsonObject, parseTagLines, toTagPlanFromJson }) {
  async function analyzeScene(config, text, options = {}) {
    const {
      availableBackgrounds,
      availableMusic,
      availableSfx,
      activeCharacters,
      recentMessages,
      currentBackground,
      currentMusic,
      inventory,
      sceneObjects,
      lastRenderReport,
    } = options;

    const recentTurns = Array.isArray(recentMessages)
      ? recentMessages
        .slice(-4)
        .map((m) => `${m?.role || 'unknown'}: ${String(m?.content || '').slice(0, 400)}`)
        .join('\n')
      : '';

    const systemPrompt = `You are a Visual Novel Director (Cinematographer & Sound Engineer).
Your job is to read the dialogue and output a JSON scene plan.

Context:
- Characters currently on stage: ${activeCharacters && activeCharacters.length ? activeCharacters.join(', ') : 'None'}
- Current background: ${currentBackground || 'none'}
- Current music: ${currentMusic || 'none'}
- Player inventory: ${Array.isArray(inventory) && inventory.length ? inventory.join(', ') : 'empty'}
- Scene objects: ${Array.isArray(sceneObjects) && sceneObjects.length ? sceneObjects.join(', ') : 'none'}
- Previous applied directives: ${lastRenderReport || 'none'}
- Recent turns:
${recentTurns || 'none'}
- Backgrounds (choose from): ${availableBackgrounds ? availableBackgrounds.slice(0, 40).join(', ') : 'any'}
- Music (choose from): ${availableMusic ? availableMusic.slice(0, 40).join(', ') : 'any'}
- SFX (choose from): ${availableSfx ? availableSfx.slice(0, 40).join(', ') : 'any'}

Instructions:
1. Output JSON only, no markdown, no prose.
2. JSON schema:
{"actions":[
  {"type":"bg","name":"backgrounds/foo.png"},
  {"type":"music","name":"music/bar.mp3"},
  {"type":"sprite","character":"Name","emotion":"happy"},
  {"type":"hide","character":"Name"},
  {"type":"sfx","name":"door_slam"},
  {"type":"fx","name":"shake"},
  {"type":"camera","mode":"zoom_in","target":"Name"},
  {"type":"take","item":"key"},
  {"type":"drop","item":"key"}
]}
3. Keep actions minimal and ordered by appearance in the scene.
4. Do not summon characters unless they physically enter or speak.
5. If no changes are needed, return {"actions":[]}.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Dialogue:\n"${text}"` }
    ];

    try {
      const responseText = await generateCompletion(config, messages, { temperature: 0.1, max_tokens: 220, useUtility: true });
      if (!responseText) return null;

      const parsed = parseFirstJsonObject(responseText);
      const structuredTags = toTagPlanFromJson(parsed);
      if (structuredTags) return structuredTags;

      return parseTagLines(responseText);
    } catch (e) {
      return null;
    }
  }

  async function runHeuristicCleanup(text, context) {
    if (!text) return text;
    let modifiedText = text;

    const injectTag = (txt, tag) => {
      if (/\[\/SCENE\]/i.test(txt)) {
        return txt.replace(/\[\/SCENE\]/i, `\n${tag}\n[/SCENE]`);
      }
      return txt + `\n${tag}`;
    };

    const tagRegex = /\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):([^\]\n]+)(?=$|\n)/g;
    modifiedText = modifiedText.replace(tagRegex, '[$1:$2]');
    modifiedText = modifiedText.replace(/\[SPRITE:\s*([^\]\/]+)\s*\/\s*([^\]]+)\]/gi, '[SPRITE: $1/$2]');

    if (context && Array.isArray(context.activeCharacters)) {
      const lower = modifiedText.toLowerCase();
      const active = context.activeCharacters;

      for (const char of active) {
        const name = char.toLowerCase();
        const patterns = [
          `${name} leaves`,
          `${name} exits`,
          `${name} walks away`,
          `${name} runs away`,
          `shoves ${name} out`,
          `pushes ${name} out`
        ];

        if (patterns.some((p) => lower.includes(p))) {
          if (!new RegExp(`\\[HIDE:\\s*${name}\\]`, 'i').test(modifiedText)) {
            modifiedText = injectTag(modifiedText, `[HIDE: ${char}]`);
          }
        }
      }

      if (active.some((c) => c.toLowerCase() === 'danny') && (lower.includes('shoves him out') || lower.includes('pushes him out'))) {
        if (!/\[HIDE:\s*Danny\]/i.test(modifiedText)) {
          modifiedText = injectTag(modifiedText, `[HIDE: Danny]`);
        }
      }
    }

    return modifiedText;
  }

  return {
    analyzeScene,
    runHeuristicCleanup,
  };
}

module.exports = { createSceneTools };

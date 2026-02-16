'use strict';

function registerMediaHandlers({
  ipcMain,
  fs,
  path,
  axios,
  nativeImage,
  aiService,
  loadConfig,
  readJsonSafe,
  readTextSafe,
  writeJsonSafe,
  getFiles,
  getManifest,
  ensureManifestCoverage,
  listCategoryFiles,
  resolveMediaAbsolutePath,
  getMimeType,
  cache,
  sanitizeFilename,
  botFilesPath,
  botImagesPath,
  PROVIDER_CATEGORIES,
  trace,
}) {
  const manifestPath = path.join(botFilesPath, 'images.json');

  function saveGeneratedBackgroundFromBuffer(imageBuffer, prompt) {
    const img = nativeImage.createFromBuffer(imageBuffer);
    if (img.isEmpty()) return null;

    const size = img.getSize();
    let out = img;
    if (size.width > 0 && size.height > 0) {
      const targetRatio = 16 / 9;
      const currentRatio = size.width / size.height;
      let cropWidth = size.width;
      let cropHeight = size.height;
      let cropX = 0;
      let cropY = 0;

      // Center-crop to 16:9 so all providers fit VN panel consistently.
      if (Math.abs(currentRatio - targetRatio) > 0.001) {
        if (currentRatio > targetRatio) {
          cropWidth = Math.floor(size.height * targetRatio);
          cropX = Math.floor((size.width - cropWidth) / 2);
        } else {
          cropHeight = Math.floor(size.width / targetRatio);
          cropY = Math.floor((size.height - cropHeight) / 2);
        }
        out = out.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight });
      }
      out = out.resize({ width: 1024, height: 576, quality: 'best' });
    }

    const jpegBuffer = out.toJPEG(80);
    const genDir = path.join(botImagesPath, 'backgrounds', 'generated');
    fs.mkdirSync(genDir, { recursive: true });

    const filename = `gen_${Date.now()}_${sanitizeFilename(prompt).slice(0, 20)}.jpg`;
    const absPath = path.join(genDir, filename);
    const relPath = `backgrounds/generated/${filename}`;
    fs.writeFileSync(absPath, jpegBuffer);

    try {
      const MAX_GENERATED = 15;
      const files = fs.readdirSync(genDir).filter((f) => f.startsWith('gen_'));
      if (files.length > MAX_GENERATED) {
        files.sort();
        const toDelete = files.slice(0, files.length - MAX_GENERATED);
        for (const f of toDelete) {
          fs.unlinkSync(path.join(genDir, f));
        }
        console.log(`[Image Gen] Pruned ${toDelete.length} old background(s).`);
      }
    } catch (e) {
      console.warn('[Image Gen] Pruning error:', e);
    }

    syncGeneratedBackgroundManifest(relPath);
    cache.invalidate('manifest');
    cache.invalidate('files:backgrounds');
    return relPath;
  }

  function syncGeneratedBackgroundManifest(latestGeneratedRelPath = null) {
    const manifest = readJsonSafe(manifestPath, {});
    manifest.backgrounds ??= {};

    let changed = false;
    for (const rel of Object.keys(manifest.backgrounds)) {
      if (!String(rel).startsWith('backgrounds/generated/')) continue;
      const abs = resolveMediaAbsolutePath({ botImagesPath, botFilesPath }, rel);
      if (!fs.existsSync(abs)) {
        delete manifest.backgrounds[rel];
        changed = true;
      }
    }

    if (latestGeneratedRelPath && !manifest.backgrounds[latestGeneratedRelPath]) {
      manifest.backgrounds[latestGeneratedRelPath] = latestGeneratedRelPath;
      changed = true;
    }

    if (changed) {
      writeJsonSafe(manifestPath, manifest);
      cache.invalidate('manifest');
    }
  }

  ipcMain.handle('get-images', () => ({
    backgrounds: getFiles('backgrounds'),
    sprites: getFiles('sprites'),
    splash: getFiles('splash'),
    music: getFiles('music'),
  }));

  ipcMain.handle('get-image-manifest', () => {
    // Prevent stale generated entries after pruning/deletes.
    syncGeneratedBackgroundManifest();
    const manifest = getManifest();

    // Ensure all disk files exist in manifest so UI can reference them
    for (const category of PROVIDER_CATEGORIES) {
      const files = getFiles(category);
      ensureManifestCoverage(manifest, category, files);
    }

    return manifest;
  });

  ipcMain.handle('get-bot-info', () => {
    const readBot = (rel) => readTextSafe(path.join(botFilesPath, rel), '').trim();

    const charDir = path.join(botFilesPath, 'characters');
    const characters = {};

    if (fs.existsSync(charDir)) {
      for (const entry of fs.readdirSync(charDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const p = readBot(`characters/${entry.name}/personality.txt`);
        if (p) characters[entry.name] = p;
      }
    }

    let spriteSizes = {};
    try {
      const raw = readTextSafe(path.join(botFilesPath, 'sprite_size.txt'), '{}');
      if (raw.trim()) spriteSizes = JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to parse sprite_size.txt', e);
    }

    return {
      personality: readBot('personality.txt'),
      scenario: readBot('scenario.txt'),
      initial: readBot('initial.txt'),
      characters,
      spriteSizes,
    };
  });

  /**
   * Scan images and auto-label them via vision.
   * Updates botFilesPath/images.json manifest.
   */
  ipcMain.handle('scan-images', async () => {
    const t = trace.createTrace('scan-images');
    const config = loadConfig();
    const settings = aiService.getProviderSettings(config);

    if (!settings.apiKey && settings.provider !== 'local') {
      return trace.ok(t, { success: false, message: 'No API key found.' });
    }

    const manifest = readJsonSafe(manifestPath, {});
    for (const k of PROVIDER_CATEGORIES) if (!manifest[k]) manifest[k] = {};

    let updated = false;
    const BATCH_SIZE = 3;

    async function processCategory(category) {
      const files = listCategoryFiles({ botImagesPath, botFilesPath }, category);
      const toProcess = files.filter((f) => !manifest[category][f]);

      for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
        const batch = toProcess.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (rel) => {
          console.log(`[Image Scan] Analyzing: ${rel}`);

          try {
            const abs = resolveMediaAbsolutePath({ botImagesPath, botFilesPath }, rel);
            const buffer = await fs.promises.readFile(abs);
            const mimeType = getMimeType(abs);

            if (mimeType.startsWith('audio/')) {
              manifest[category][rel] = 'Audio file';
              updated = true;
              return;
            }

            const result = await aiService.generateCompletion(
              config,
              [{
                role: 'user',
                content: [
                  { type: 'text', text: 'Describe this image in 5 words or less for a visual novel script.' },
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
                ],
              }],
              { max_tokens: 50 }
            );

            if (result) {
              manifest[category][rel] = result.trim();
              updated = true;
            }
          } catch (e) {
            console.error(`[Image Scan] Error ${rel}:`, e?.message ?? e);
          }
        }));
      }
    }

    for (const category of PROVIDER_CATEGORIES) {
      await processCategory(category);
    }

    if (updated) {
      writeJsonSafe(manifestPath, manifest);
      cache.invalidate();
      return trace.ok(t, { success: true, message: 'Manifest updated.' });
    }

    return trace.ok(t, { success: true, message: 'No new images found.' });
  });

  /**
   * Image Generation (Pollinations.ai)
   */
  ipcMain.handle('generate-image', async (_event, prompt, type) => {
    const t = trace.createTrace('generate-image');
    try {
      if (type && type !== 'bg') {
        return trace.fail(t, 'IMAGE_GEN_UNSUPPORTED_TYPE', `Unsupported image generation type: ${String(type)}`);
      }

      const config = loadConfig();
      const pollinationsKey =
        String(
          config?.pollinationsApiKey ||
          config?.apiKeys?.pollinations ||
          config?.apiKeys?.pollinations_image ||
          process.env.POLLINATIONS_API_KEY ||
          ''
        ).trim();

      const rawPrompt = String(prompt || '').replace(/[_-]+/g, ' ').trim();
      const enhancedPrompt = `(masterpiece, best quality), ${rawPrompt}, detailed scenery, visual novel background, anime style, no characters`;
      const seed = Math.floor(Math.random() * 1000000);

      // 0) Local Stable Diffusion WebUI first (if running)
      try {
        const config = loadConfig();
        const sdBase = String(config?.sdBaseUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '');
        const sdUrl = `${sdBase}/sdapi/v1/txt2img`;
        const sdPayload = {
          prompt: enhancedPrompt,
          negative_prompt: 'text, watermark, logo, signature, low quality, blurry, bad anatomy, people, person, character',
          width: 1024,
          height: 576,
          steps: 20,
          cfg_scale: 7,
          sampler_name: 'DPM++ 2M Karras',
          seed,
        };

        console.log(`[Image Gen] Trying local SD: ${sdUrl}`);
        const sdResp = await axios.post(sdUrl, sdPayload, { timeout: 20_000 });
        const first = sdResp?.data?.images?.[0];
        if (typeof first === 'string' && first.length > 100) {
          const b64 = first.includes(',') ? first.split(',').pop() : first;
          const localBuffer = Buffer.from(b64, 'base64');
          const relPath = saveGeneratedBackgroundFromBuffer(localBuffer, rawPrompt || 'background');
          if (relPath) return trace.ok(t, relPath);
        }
      } catch (e) {
        // Not fatal: fallback to Pollinations path.
        console.warn('[Image Gen] Local SD unavailable, falling back to Pollinations:', e?.message || e);
      }

      const stripRiskTerms = (s) => String(s || '')
        .replace(/\b(blood|gore|violent|violence|battle|war|weapon|wound|scar|scars|corpse|dead|death|killed?|horror)\b/gi, '')
        .replace(/[^\w\s,.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const safeCore = stripRiskTerms(rawPrompt).slice(0, 160);
      const safePrompt = `anime visual novel background, ${safeCore || 'fantasy castle courtyard'}, daylight, scenic environment, no characters`;
      const ultraSafePrompt = `anime fantasy landscape background, ${safeCore || 'stone castle'}, no characters`;

      const promptVariants = Array.from(new Set([
        enhancedPrompt,
        rawPrompt,
        safePrompt,
        ultraSafePrompt,
      ].map((p) => String(p || '').trim()).filter(Boolean)));

      const sizeVariants = [
        // Keep direct-fit first (can work sometimes).
        { width: 1024, height: 576 },
        // Square requests are often more reliable upstream.
        { width: 1024, height: 1024 },
        { width: 512, height: 512 },
      ];

      const candidates = [];
      let attemptSeed = seed;
      for (const p of promptVariants) {
        const clipped = p.slice(0, 260);
        const encoded = encodeURIComponent(clipped);
        const keyParam = pollinationsKey ? `&key=${encodeURIComponent(pollinationsKey)}` : '';

        // Unified API first (current/official path)
        candidates.push({
          provider: 'pollinations-gen',
          prompt: clipped,
          url: `https://gen.pollinations.ai/image/${encoded}?model=flux${keyParam}`,
        });

        for (const sz of sizeVariants) {
          // Legacy endpoint fallback (currently unstable in some regions).
          candidates.push({
            provider: 'pollinations-legacy',
            prompt: clipped,
            url: `https://image.pollinations.ai/prompt/${encoded}?width=${sz.width}&height=${sz.height}&seed=${attemptSeed++}&nologo=true`,
          });
          if (candidates.length >= 10) break;
        }
        if (candidates.length >= 10) break;
      }

      let response = null;
      let lastErr = null;
      let sawAuth401 = false;
      let sawGenAuth401 = false;
      for (let i = 0; i < candidates.length; i++) {
        const { url, prompt: candidatePrompt, provider } = candidates[i];
        try {
          console.log(`[Image Gen] Attempt ${i + 1}/${candidates.length} [${provider}]: ${url}`);
          console.log(`[Image Gen] Prompt [${provider}]: ${candidatePrompt}`);
          response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
          if (response?.data) break;
        } catch (e) {
          lastErr = e;
          const status = e?.response?.status;
          if (status === 401) sawAuth401 = true;
          if (status === 401 && provider === 'pollinations-gen') sawGenAuth401 = true;
          console.warn(`[Image Gen] Attempt ${i + 1} failed${status ? ` (HTTP ${status})` : ''}:`, e?.message || e);
        }
      }

      if (response?.data) {
        const buffer = Buffer.from(response.data);
        const relPath = saveGeneratedBackgroundFromBuffer(buffer, rawPrompt || 'background');
        if (relPath) return trace.ok(t, relPath);
      }

      if (lastErr) {
        const status = lastErr?.response?.status;
        // If a user configured a key but gen endpoint rejects it, surface as actionable fatal error.
        if (sawGenAuth401 && pollinationsKey) {
          return trace.fail(t, 'IMAGE_GEN_AUTH_INVALID', 'Pollinations image key was rejected (HTTP 401). Check or replace your key.', { provider: 'pollinations-gen' }, lastErr);
        }

        // Keyless mode: treat auth-required on gen endpoint as soft failure and let caller fallback.
        if (sawAuth401 && !pollinationsKey) {
          console.warn('[Image Gen] Pollinations gen endpoint requires auth for this prompt (keyless mode). Returning null for graceful fallback.');
          return trace.ok(t, null);
        }

        // Upstream Pollinations can return intermittent Cloudflare 530.
        // Treat as a soft failure so renderer can apply a graceful fallback.
        if (status === 530) {
          console.warn('[Image Gen] Upstream returned HTTP 530 after retries. Returning null for graceful fallback.');
          return trace.ok(t, null);
        }

        const message = status
          ? `Image generation failed after retries (HTTP ${status}).`
          : `Image generation failed after retries: ${lastErr?.message || 'Unknown error'}`;
        return trace.fail(t, 'IMAGE_GEN_ERROR', message, null, lastErr);
      }
    } catch (e) {
      return trace.fail(t, 'IMAGE_GEN_ERROR', trace.normalizeErrorMessage(e, 'Image generation failed.'), null, e);
    }
    return trace.ok(t, null);
  });
}

module.exports = { registerMediaHandlers };

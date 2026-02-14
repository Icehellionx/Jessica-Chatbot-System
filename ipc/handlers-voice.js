'use strict';

function registerVoiceHandlers({
  ipcMain,
  fs,
  path,
  process,
  axios,
  execFile,
  checkVoiceGender,
  getVoiceMap,
  getVoiceBuckets,
  assignVoiceId,
  writeJsonSafe,
  botFilesPath,
  voiceMapPath,
  voiceBucketsPath,
  userDataPath,
  trace,
}) {
  ipcMain.handle('clear-voice-map', () => {
    const t = trace.createTrace('clear-voice-map');
    try {
      if (fs.existsSync(voiceMapPath)) fs.unlinkSync(voiceMapPath);
      return trace.ok(t, true);
    } catch {
      return trace.ok(t, false);
    }
  });

  ipcMain.handle('get-voice-map', () => {
    const t = trace.createTrace('get-voice-map');
    return trace.ok(t, getVoiceMap(voiceMapPath, botFilesPath));
  });

  ipcMain.handle('save-voice-map', (_e, map) => {
    const t = trace.createTrace('save-voice-map');
    writeJsonSafe(voiceMapPath, map);
    return trace.ok(t, true);
  });

  ipcMain.handle('scan-voice-buckets', async () => {
    const t = trace.createTrace('scan-voice-buckets');
    const buckets = { male: [], female: [] };
    const piperDir = path.resolve(botFilesPath, '../tools/piper');
    const piperBinary = process.platform === 'win32' ? 'piper.exe' : 'piper';
    const piperPath = path.join(piperDir, piperBinary);

    let modelName = 'en_US-libritts_r-medium.onnx';
    if (!fs.existsSync(path.join(piperDir, modelName))) {
      const found = fs.readdirSync(piperDir).find((f) => f.endsWith('.onnx'));
      if (found) modelName = found;
    }
    const modelPath = path.join(piperDir, modelName);

    if (!fs.existsSync(piperPath) || !fs.existsSync(modelPath)) {
      return trace.ok(t, { success: false, message: 'Piper not found' });
    }

    let jsonPath = modelPath + '.json';
    if (!fs.existsSync(jsonPath)) jsonPath = modelPath.replace(/\.onnx$/, '.json');

    let added = 0;
    let method = 'Pitch Scan';

    if (fs.existsSync(jsonPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (config.speaker_id_map) {
          for (const [name, id] of Object.entries(config.speaker_id_map)) {
            const lower = name.toLowerCase();
            if (lower.match(/^f\d+$/) || ['belinda', 'alicia', 'anika', 'annie', 'linda', 'shelby', 'steph', 'whisperf', 'salli', 'amy', 'kimberly'].includes(lower)) {
              buckets.female.push(id);
              added++;
            } else if (lower.match(/^m\d+$/) || ['adam', 'alex', 'andy', 'boris', 'david', 'edward', 'gene', 'john', 'mike', 'paul', 'robert', 'travis', 'joey', 'brian', 'matthew'].includes(lower)) {
              buckets.male.push(id);
              added++;
            }
          }
          if (added > 0) method = 'Name Map';
        }
      } catch (e) {
        console.error('Config parse error', e);
      }
    }

    if (added === 0) {
      for (let i = 0; i < 50; i++) {
        const id = Math.floor(Math.random() * 900);
        const pitch = await checkVoiceGender(piperPath, modelPath, piperDir, id, 'X', userDataPath);
        if (pitch > 175) { buckets.female.push(id); added++; }
        else if (pitch > 60 && pitch < 155) { buckets.male.push(id); added++; }
      }
    }

    writeJsonSafe(voiceBucketsPath, buckets);
    return trace.ok(t, { success: true, message: `Method: ${method}. Added ${added} voices to buckets.` });
  });

  ipcMain.handle('generate-speech', async (_event, text, voiceId, forcedSpeakerId) => {
    const t = trace.createTrace('generate-speech', { voiceId: String(voiceId || '') });
    let audioData = null;
    let piperError = null;

    try {
      const piperDir = path.resolve(botFilesPath, '../tools/piper');
      const piperBinary = process.platform === 'win32' ? 'piper.exe' : 'piper';
      const piperPath = path.join(piperDir, piperBinary);

      if (fs.existsSync(piperPath)) {
        let modelName = 'en_US-libritts_r-medium.onnx';
        if (!fs.existsSync(path.join(piperDir, modelName))) {
          const found = fs.readdirSync(piperDir).find((f) => f.endsWith('.onnx'));
          if (found) modelName = found;
        }

        const modelPath = path.join(piperDir, modelName);
        let jsonPath = modelPath + '.json';
        if (!fs.existsSync(jsonPath)) jsonPath = modelPath.replace(/\.onnx$/, '.json');

        if (fs.existsSync(modelPath) && fs.existsSync(jsonPath)) {
          let isMultiSpeaker = false;
          try {
            const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            isMultiSpeaker = (config.num_speakers > 1) || (config.speaker_id_map && Object.keys(config.speaker_id_map).length > 0);
            console.log(`[Piper] Model: ${modelName}, Multi-Speaker: ${isMultiSpeaker}`);
          } catch (e) {
            console.log('[Piper] Config read error, defaulting to single speaker:', e.message);
          }

          const tempFile = path.join(userDataPath, `vn_tts_${Date.now()}.wav`);
          const args = ['--model', modelPath, '--output_file', tempFile, '--length_scale', '1.1'];

          if (isMultiSpeaker) {
            let spkId;
            if (forcedSpeakerId !== undefined && forcedSpeakerId !== null) {
              spkId = String(forcedSpeakerId);
              console.log(`[Piper] Using forced Speaker ID: ${spkId}`);
            } else {
              const voiceMap = getVoiceMap(voiceMapPath, botFilesPath);
              const buckets = getVoiceBuckets(voiceBucketsPath);
              if (voiceMap[voiceId] === undefined) {
                voiceMap[voiceId] = assignVoiceId(voiceId, botFilesPath, voiceMap, buckets);
                writeJsonSafe(voiceMapPath, voiceMap);
              }
              spkId = String(voiceMap[voiceId]);
              console.log(`[Piper] Generating for "${voiceId}" -> Speaker ID: ${spkId}`);
            }
            args.push('--speaker', spkId);
          } else {
            console.log('[Piper] Single speaker model detected. Ignoring voice map.');
          }

          console.log(`[Piper] Executing: ${piperBinary} ${args.join(' ')}`);
          audioData = await new Promise((resolve, reject) => {
            const child = execFile(
              piperPath,
              args,
              { cwd: piperDir, windowsHide: true },
              async (err, stdout, stderr) => {
                if (err) {
                  console.warn('[Piper] Execution Error:', err);
                  if (stderr) console.warn('[Piper] Stderr:', stderr.toString());
                  reject(new Error(`Piper exited with error: ${err.message}. Stderr: ${stderr ? stderr.toString() : ''}`));
                  return;
                }

                try {
                  if (fs.existsSync(tempFile)) {
                    const audioBuffer = await fs.promises.readFile(tempFile);
                    try { await fs.promises.unlink(tempFile); } catch {}

                    if (audioBuffer.length >= 4 && audioBuffer.toString('utf8', 0, 4) === 'RIFF') {
                      resolve(`data:audio/wav;base64,${audioBuffer.toString('base64')}`);
                    } else {
                      reject(new Error('Piper output file was not a valid WAV.'));
                    }
                  } else {
                    reject(new Error(`Piper produced no output file. Stderr: ${stderr ? stderr.toString() : ''}`));
                  }
                } catch (e) {
                  reject(new Error(`Failed to read Piper output: ${e.message}`));
                }
              }
            );

            if (child.stdin) {
              child.stdin.write(text);
              child.stdin.end();
            }
          }).catch((e) => {
            piperError = e;
            return null;
          });
        } else {
          console.log(`[Piper] Missing files! Found .onnx: ${fs.existsSync(modelPath)}, Found .json: ${fs.existsSync(jsonPath)}`);
          piperError = new Error('Piper model files (.onnx or .json) missing.');
        }
      } else {
        piperError = new Error(`Piper binary not found at ${piperPath}`);
      }
    } catch (e) {
      console.log('[Piper] Setup failed:', e.message);
      piperError = e;
    }

    if (audioData) return trace.ok(t, audioData);

    const SE_VOICE_MAP = {
      narrator: 'Matthew',
      jessica: 'Salli',
      danny: 'Joey',
      jake: 'Brian',
      natasha: 'Amy',
      suzie: 'Kimberly',
      character_generic_male: 'Joey',
      character_generic_female: 'Joanna',
    };

    const seVoice = SE_VOICE_MAP[voiceId] || 'Joanna';

    try {
      const url = 'https://api.streamelements.com/kappa/v2/speech';
      const response = await axios.get(url, {
        params: { voice: seVoice, text },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer',
      });

      if (response.headers['content-type']?.includes('audio')) {
        return trace.ok(t, `data:audio/mp3;base64,${Buffer.from(response.data).toString('base64')}`);
      }
      console.warn('[StreamElements] API returned non-audio:', response.headers['content-type']);
    } catch (e) {
      console.warn('StreamElements TTS failed (offline?), falling back to browser:', e.message);
    }

    if (piperError) {
      return trace.fail(t, 'TTS_GENERATION_ERROR', trace.normalizeErrorMessage(piperError, 'Audio generation failed.'), null, piperError);
    }
    return trace.fail(
      t,
      'TTS_GENERATION_ERROR',
      'Audio generation failed (Piper missing/broken and StreamElements unreachable).'
    );
  });
}

module.exports = { registerVoiceHandlers };

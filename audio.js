let currentMusic = null;
let musicVolume = 0.5;
let isMuted = false;
const LOOP_CROSSFADE_DURATION = 2000;

function setupVolumeControls() {
    const volumeContainer = document.createElement('div');
    volumeContainer.id = 'volume-controls';
    volumeContainer.style.cssText = `
        display: flex;
        align-items: center;
        margin-right: 15px;
    `;
    
    const muteBtn = document.createElement('button');
    muteBtn.id = 'mute-btn';
    muteBtn.textContent = '🔊';
    muteBtn.style.cssText = `
        background: none;
        border: none;
        color: #ddd;
        font-size: 16px;
        cursor: pointer;
        margin-right: 8px;
        padding: 0;
        line-height: 1;
    `;
    
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.id = 'volume-slider';
    volumeSlider.min = 0;
    volumeSlider.max = 1;
    volumeSlider.step = 0.05;
    volumeSlider.value = musicVolume;
    volumeSlider.style.cssText = `
        width: 80px;
        cursor: pointer;
        accent-color: #0078d4;
    `;
    
    volumeContainer.appendChild(muteBtn);
    volumeContainer.appendChild(volumeSlider);
    
    const toolbar = document.getElementById('toolbar');
    const undoBtn = document.getElementById('undo-btn');
    
    if (toolbar && undoBtn) {
        toolbar.insertBefore(volumeContainer, undoBtn);
    } else if (toolbar) {
        toolbar.appendChild(volumeContainer);
    }

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.textContent = isMuted ? '🔇' : '🔊';
        if (currentMusic) {
            currentMusic.muted = isMuted;
        }
    });

    volumeSlider.addEventListener('input', (e) => {
        musicVolume = parseFloat(e.target.value);
        if (currentMusic) {
            currentMusic.volume = musicVolume;
        }
        if (musicVolume > 0 && isMuted) {
            isMuted = false;
            muteBtn.textContent = '🔊';
            if (currentMusic) currentMusic.muted = false;
        }
    });
}

function playMusic(filename) {
    const isStop = !filename || filename.toLowerCase() === 'none' || filename.toLowerCase() === 'stop';

    if (currentMusic) {
        // Check if same music is requested
        if (!isStop) {
            const currentSrc = decodeURIComponent(currentMusic.src);
            if (currentSrc.includes(filename) && !currentMusic.ended) {
                return;
            }
        }
        
        // Stop current music
        if (currentMusic.loopTimer) clearTimeout(currentMusic.loopTimer);
        
        const oldMusic = currentMusic;
        if (oldMusic.fadeInterval) clearInterval(oldMusic.fadeInterval);
        fadeOut(oldMusic);
        currentMusic = null;
    }
    
    if (isStop) return;

    currentMusic = createAudioObject(filename);
    
    currentMusic.play().then(() => {
        fadeIn(currentMusic);
    }).catch(e => {
        console.error("Failed to play music:", e);
        currentMusic = null;
    });
}

function createAudioObject(filename) {
    const audio = new Audio(`bot-resource://${filename}`);
    audio.loop = false; // We handle looping manually for crossfade
    audio.muted = isMuted;
    audio.volume = 0;

    const tryTriggerLoop = () => {
        if (currentMusic !== audio) return;
        if (audio.loop) return;
        if (audio.isCrossfading) return;

        audio.isCrossfading = true;
        triggerLoop(filename);
    };

    // Use timeupdate for precise crossfade timing
    audio.addEventListener('timeupdate', () => {
        // If we are within the crossfade window (2 seconds before end)
        if (audio.duration && audio.currentTime > audio.duration - (LOOP_CROSSFADE_DURATION / 1000)) {
            tryTriggerLoop();
        }
    });

    audio.addEventListener('ended', () => {
        tryTriggerLoop();
    });

    audio.addEventListener('loadedmetadata', () => {
        // Fallback for very short clips
        if (audio.duration && audio.duration < (LOOP_CROSSFADE_DURATION / 1000) * 2) {
            audio.loop = true;
        }
    });
    return audio;
}

function triggerLoop(filename) {
    if (!currentMusic) return; // Music stopped
    
    const oldMusic = currentMusic;
    const newMusic = createAudioObject(filename);
    
    currentMusic = newMusic; // Update reference so stop commands affect the new one
    
    newMusic.play().then(() => {
        if (currentMusic !== newMusic) {
            newMusic.pause();
            return;
        }
        fadeIn(newMusic, LOOP_CROSSFADE_DURATION);
        fadeOut(oldMusic, LOOP_CROSSFADE_DURATION);
    }).catch(e => {
        console.error("Loop failed:", e);
        if (currentMusic === newMusic) currentMusic = null;
    });
}

function fadeOut(audio, duration = 1000) {
    if (!audio) return;
    const interval = 50;
    const step = audio.volume / (duration / interval);
    
    const fadeId = setInterval(() => {
        if (audio.volume > step) {
            audio.volume -= step;
        } else {
            audio.volume = 0;
            audio.pause();
            clearInterval(fadeId);
        }
    }, interval);
    audio.fadeInterval = fadeId;
}

function fadeIn(audio, duration = 1000) {
    if (!audio) return;
    const interval = 50;
    
    const fadeId = setInterval(() => {
        const target = musicVolume;
        const step = target / (duration / interval);
        
        if (audio.volume < target - step) {
            audio.volume += step;
        } else {
            audio.volume = target;
            clearInterval(fadeId);
            audio.fadeInterval = null;
        }
    }, interval);
    audio.fadeInterval = fadeId;
}

function getCurrentMusicFilename() {
    if (currentMusic && !currentMusic.paused) {
         if (currentMusic.src.includes('bot-resource://')) {
             return decodeURIComponent(currentMusic.src.split('bot-resource://')[1]);
         }
    }
    return '';
}

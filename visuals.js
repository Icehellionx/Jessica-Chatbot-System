window.imageManifest = { backgrounds: {}, sprites: {}, splash: {}, music: {} };
const activeSprites = new Map();

function setupVisuals() {
    // Inject CSS for multi-sprite support
    const spriteStyle = document.createElement('style');
    spriteStyle.textContent = `
        #vn-panel {
            aspect-ratio: 16 / 9 !important;
            height: auto !important;
            align-self: center !important;
            flex: none !important;
            max-height: none !important;
        }
        #vn-bg {
            width: 100%;
            height: 100%;
            object-fit: cover;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 0;
        }
        .bg-overlay {
            width: 100%;
            height: 100%;
            object-fit: cover;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 1;
            transition: opacity 1s ease-in-out;
        }
        #sprite-container {
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: flex-end;
            pointer-events: none;
            overflow: visible;
            z-index: 10;
        }
        .character-sprite {
            height: 100%;
            max-width: 60%;
            object-fit: contain;
            object-position: bottom;
            width: auto;
            transition: all 0.5s ease-in-out;
            will-change: transform, opacity;
            margin: 0 -2%;
            transform: translateY(20px);
            opacity: 0;
            filter: drop-shadow(0 0 15px rgba(0,0,0,0.8));
        }
        .character-sprite.active {
            transform: translateY(0);
            opacity: 1;
        }
        .msg-reroll-btn {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 18px;
            margin-left: 10px;
            padding: 0 5px;
            float: right;
        }
        .msg-reroll-btn:hover {
            color: #0078d4;
        }
        #splash-container {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 20;
            pointer-events: none;
            opacity: 0;
            transition: opacity 1s ease-in-out;
        }
        #splash-container.active {
            opacity: 1;
            pointer-events: auto;
        }
        .splash-image {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        #loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 9999;
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            font-size: 24px;
            font-family: sans-serif;
            opacity: 0;
            pointer-events: none;
            user-select: none;
            -webkit-user-select: none;
            transition: opacity 0.3s ease;
        }
        #loading-overlay * {
            pointer-events: none;
        }
        #loading-overlay.active {
            opacity: 1;
            pointer-events: none;
        }
        #setup-modal, #persona-modal, #options-modal, #summary-modal, #load-modal {
            z-index: 10001;
        }
    `;
    document.head.appendChild(spriteStyle);
}

async function preloadImages() {
    const images = await window.api.getImages();
    const load = (list) => {
        list.forEach(file => {
            const img = new Image();
            img.src = `bot-resource://${file}`;
        });
    };
    load(images.backgrounds);
    // Sprites are now loaded on demand to save memory
    // load(images.sprites);
}

/**
 * Finds a valid image path from the manifest based on a fuzzy input string.
 * @param {string} filename - The input tag value (e.g. "happy", "Jessica/happy")
 * @param {string} type - The category (backgrounds, sprites, etc.)
 * @returns {string|null} - The full relative path or null
 */
function validateImage(filename, type) {
    if (!window.imageManifest[type]) return null;
    
    // Decode in case it's URL encoded
    let cleanName = decodeURIComponent(filename);

    // Clean filename of potential trailing/leading quotes or slashes
    cleanName = cleanName.replace(/^['"\\/]+|['"\\/]+$/g, '').trim();
    
    // Normalize slashes to forward slash for comparison
    cleanName = cleanName.replace(/\\/g, '/');

    // 1. Check if it exists as a key directly
    if (window.imageManifest[type][cleanName]) return cleanName;

    const keys = Object.keys(window.imageManifest[type]);
    const lowerClean = cleanName.toLowerCase();

    // 2. Try adding extensions (if missing)
    const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.ogg'];
    for (const ext of extensions) {
        if (window.imageManifest[type][cleanName + ext]) return cleanName + ext;
    }

    // 3. Fuzzy match (Fallback for hallucinations like "coffee_shop" -> "coffee_shop.png")
    for (const key of keys) {
        const lowerKey = key.toLowerCase();
        
        // Strict case-insensitive match
        if (lowerKey === lowerClean) return key;
        
        // Match without extension
        const keyNoExt = lowerKey.substring(0, lowerKey.lastIndexOf('.'));
        if (keyNoExt === lowerClean) return key;

        // Check for short path match (suffix)
        if (keyNoExt.endsWith(lowerClean)) {
            const prefixIndex = keyNoExt.length - lowerClean.length;
            if (prefixIndex === 0 || keyNoExt[prefixIndex - 1] === '/') {
                return key;
            }
        }
        
        // Handle "Character/Sprite" format where file might be "Character_Sprite.png"
        if (lowerClean.includes('/')) {
            const parts = lowerClean.split('/');
            if (parts.length === 2) {
                const [group, item] = parts;
                // Check if key is in the correct group folder
                if (lowerKey.includes(`/${group}/`) || lowerKey.startsWith(`${group}/`)) {
                    const keyFilename = lowerKey.split('/').pop();
                    const keyFilenameNoExt = keyFilename.substring(0, keyFilename.lastIndexOf('.'));
                    
                    if (keyFilenameNoExt.includes(item)) {
                        return key;
                    }
                }
            }
        }
    }
    
    return null;
}

function findBestSprite(characterName, mood) {
    // Filter manifest for this character
    const charFiles = Object.keys(window.imageManifest.sprites).filter(file => getCharacterName(file) === characterName);
    if (charFiles.length === 0) return null;

    // 1. Try to find exact mood match in parentheses e.g. "(Happy)"
    for (const file of charFiles) {
        const desc = window.imageManifest.sprites[file];
        if (desc && desc.toLowerCase().includes(`(${mood.toLowerCase()})`)) {
            return file;
        }
    }

    // 2. If no exact match, search description for mood name
    if (mood !== 'Default') {
        for (const file of charFiles) {
            const desc = window.imageManifest.sprites[file];
            if (desc && desc.toLowerCase().includes(mood.toLowerCase())) {
                return file;
            }
        }
    }

    // 3. Fallback to Default
    for (const file of charFiles) {
        const desc = window.imageManifest.sprites[file];
        if (desc && desc.toLowerCase().includes('default')) {
            return file;
        }
    }
    
    // 4. Absolute fallback to first sprite
    return charFiles[0];
}

function setupSpriteContainer() {
    let container = document.getElementById('sprite-container');
    if (!container) {
        const oldSprite = document.getElementById('vn-sprite');
        if (oldSprite && oldSprite.parentNode) {
            container = document.createElement('div');
            container.id = 'sprite-container';
            oldSprite.parentNode.insertBefore(container, oldSprite);
            oldSprite.style.display = 'none'; // Hide legacy sprite
        }
    }
    return container;
}

function getCharacterName(filename) {
    // Handle paths like "characters/Jessica/happy.png" or "sprites/Jessica/happy.png"
    const parts = filename.split(/[/\\]/);
    
    if (parts[0] === 'characters' && parts.length >= 3) {
        return parts[1].toLowerCase();
    }
    if (parts[0] === 'sprites' && parts.length >= 3) {
        return parts[1].toLowerCase();
    }
    // Handle short paths like "Jessica/happy.png" (parts = ['Jessica', 'happy.png'])
    if (parts.length === 2) {
        return parts[0].toLowerCase();
    }
    
    // Heuristic: "jessica_happy.png" -> "jessica"
    const base = filename.split('/').pop();
    
    // Only strip extension/suffix if it looks like a file (has an image extension)
    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(base)) {
        return base.split(/[_\-\.]/)[0].toLowerCase();
    }
    
    return base.toLowerCase();
}

function changeBackground(filename) {
    hideSplash();
    const bgElement = document.getElementById('vn-bg');
    if (!bgElement) return;

    const newSrc = `bot-resource://${filename}`;
    // Don't transition if it's the same image
    if (bgElement.src === newSrc) return;

    // Create an overlay with the OLD image
    const overlay = document.createElement('img');
    overlay.src = bgElement.src;
    overlay.className = 'bg-overlay';
    bgElement.parentNode.insertBefore(overlay, bgElement.nextSibling);

    // Set the main element to the NEW image immediately (behind overlay)
    bgElement.src = newSrc;

    // Fade out the overlay
    requestAnimationFrame(() => {
        overlay.style.opacity = '0';
    });

    // Remove overlay after transition
    setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 1000);
}

function getSpriteRects() {
    const rects = new Map();
    activeSprites.forEach((img, name) => {
        rects.set(name, img.getBoundingClientRect());
    });
    return rects;
}

function updateSprite(filename) {
    hideSplash();
    const container = setupSpriteContainer();
    if (!container) return;

    // Capture positions of existing sprites before adding new one
    const oldRects = getSpriteRects();

    const name = getCharacterName(filename);
    let img = activeSprites.get(name);

    if (!img) {
        img = document.createElement('img');
        img.className = 'character-sprite';
        img.decoding = 'async';
        img.src = `bot-resource://${filename}`;
        container.appendChild(img);
        activeSprites.set(name, img);
        
        // Force reflow to ensure transition plays
        void img.offsetWidth; 
        img.classList.add('active');
    } else {
        if (!img.src.includes(filename)) {
            img.src = `bot-resource://${filename}`;
        }
        if (!img.classList.contains('active')) {
            img.classList.add('active');
        }
    }

    // Height adjustment for specific characters (e.g. tall hair)
    if (name.includes('natasha')) {
        img.style.height = '103%';
        img.style.maxWidth = 'none';
    } else {
        img.style.height = '';
        img.style.maxWidth = '';
    }

    adjustSpriteOverlap();

    // Animate existing sprites sliding to new positions (FLIP)
    animateLayoutChanges(oldRects);
}

function hideSprite(nameOrFilename) {
    hideSplash();
    
    // Support HIDE: ALL to clear screen
    if (nameOrFilename.toLowerCase() === 'all' || nameOrFilename.toLowerCase() === 'everyone') {
        activeSprites.forEach((img) => {
            img.classList.remove('active');
            setTimeout(() => {
                if (img.parentNode) img.parentNode.removeChild(img);
                img.src = '';
            }, 500);
        });
        activeSprites.clear();
        return;
    }

    // Capture positions before removing
    const oldRects = getSpriteRects();

    let name = getCharacterName(nameOrFilename);
    let img = activeSprites.get(name);

    // Fuzzy match if not found (e.g. "Jessica Smith" vs "jessica")
    if (!img) {
        const lowerInput = nameOrFilename.toLowerCase();
        for (const [key, val] of activeSprites.entries()) {
            if (lowerInput.includes(key)) {
                name = key;
                img = val;
                break;
            }
        }
    }

    if (img) {
        img.classList.remove('active');
        activeSprites.delete(name);
        adjustSpriteOverlap();

        setTimeout(() => {
            if (img.parentNode) {
                img.parentNode.removeChild(img);
            }
            img.src = ''; // Clear source to assist with memory release
        }, 500); // Match CSS transition
    }
}

function showSplash(filename) {
    let container = document.getElementById('splash-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'splash-container';
        const img = document.createElement('img');
        img.className = 'splash-image';
        container.appendChild(img);
        
        // Insert into panel
        const panel = document.getElementById('vn-panel');
        panel.appendChild(container);
    }
    
    const img = container.querySelector('img');
    img.src = `bot-resource://${filename}`;
    
    // Force reflow
    void container.offsetWidth;
    container.classList.add('active');
}

function hideSplash() {
    const container = document.getElementById('splash-container');
    if (container) {
        container.classList.remove('active');
    }
}

function animateLayoutChanges(oldRects) {
    activeSprites.forEach((img, name) => {
        const oldRect = oldRects.get(name);
        if (oldRect) {
            const newRect = img.getBoundingClientRect();
            const dx = oldRect.left - newRect.left;
            if (dx !== 0) {
                // Invert: Move back to old position
                img.style.transition = 'none';
                img.style.transform = `translateX(${dx}px) translateY(0)`;
                
                // Force reflow
                void img.offsetWidth;

                // Play: Animate to new position
                img.style.transition = 'all 0.5s ease-in-out';
                img.style.transform = ''; // Revert to CSS class (translateY(0))
            }
        }
    });
}

function adjustSpriteOverlap() {
    const container = document.getElementById('sprite-container');
    if (!container) return;
    
    const allSprites = Array.from(container.getElementsByClassName('character-sprite'));
    const activeCount = allSprites.filter(s => s.classList.contains('active')).length;
    
    let margin = -2; 
    if (activeCount > 2) {
        margin = -2 - ((activeCount - 2) * 2);
    }
    
    allSprites.forEach(s => {
        s.style.marginLeft = `${margin}%`;
        s.style.marginRight = `${margin}%`;
    });
}

// Shared regex patterns for tags
const visualTagRegexes = {
    bg: /\[BG:\s*["']?([^"\]]*)["']?\]/gi,
    sprite: /\[SPRITE:\s*["']?([^"\]]*)["']?\]/gi,
    splash: /\[SPLASH:\s*["']?([^"\]]*)["']?\]/gi,
    music: /\[MUSIC:\s*["']?([^"\]]*)["']?\]/gi,
    hide: /\[HIDE:\s*["']?([^"\]]*)["']?\]/gi
};

function stripVisualTags(text) {
    if (!text) return '';
    let cleanedText = text
        .replace(visualTagRegexes.bg, '')
        .replace(visualTagRegexes.sprite, '')
        .replace(visualTagRegexes.splash, '')
        .replace(visualTagRegexes.music, '')
        .replace(visualTagRegexes.hide, '');
    return cleanedText.replace(/\n{3,}/g, '\n\n').trim();
}

function processVisualTags(text) {
    // Collect all matches
    const matches = [];
    const addMatches = (regex, type) => {
        for (const match of text.matchAll(regex)) {
            matches.push({
                type,
                value: match[1].trim(),
                index: match.index
            });
        }
    };
    addMatches(visualTagRegexes.bg, 'bg');
    addMatches(visualTagRegexes.sprite, 'sprite');
    addMatches(visualTagRegexes.splash, 'splash');
    addMatches(visualTagRegexes.music, 'music');
    addMatches(visualTagRegexes.hide, 'hide');

    // Sort by index to process in order
    matches.sort((a, b) => a.index - b.index);

    // Auto-hide splash if no splash tag is present in the new text
    if (!matches.some(m => m.type === 'splash')) {
        hideSplash();
    }

    // Process all tags in order
    matches.forEach(match => {
        if (match.type === 'bg') {
            if (match.value) {
                const validBg = validateImage(match.value, 'backgrounds');
                if (validBg) {
                    changeBackground(validBg);
                } else {
                    console.warn(`[Visual Novel] Invalid BG tag ignored: ${match.value}`);
                }
            }
        } else if (match.type === 'sprite') {
            const validSprite = validateImage(match.value, 'sprites');
            if (validSprite) {
                updateSprite(validSprite);
            } else {
                console.warn(`[Visual Novel] Invalid SPRITE tag ignored: ${match.value}`);
            }
        } else if (match.type === 'splash') {
            const validSplash = validateImage(match.value, 'splash');
            if (validSplash) {
                showSplash(validSplash);
            } else {
                console.warn(`[Visual Novel] Invalid SPLASH tag ignored: ${match.value}`);
            }
        } else if (match.type === 'music') {
            const validMusic = validateImage(match.value, 'music');
            if (validMusic) {
                playMusic(validMusic);
            } else if (match.value.toLowerCase() === 'stop') {
                playMusic(null);
            } else {
                console.warn(`[Visual Novel] Invalid MUSIC tag ignored: ${match.value}`);
            }
        } else if (match.type === 'hide') {
            hideSprite(match.value);
        }
    });

    // Return cleaned text for convenience, though we now use stripVisualTags explicitly in renderer
    return stripVisualTags(text);
}

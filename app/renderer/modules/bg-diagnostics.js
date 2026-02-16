'use strict';

const BG_DIAG_PANEL_ID = 'bg-diag-panel';
const BG_DIAG_PRE_ID = 'bg-diag-panel-pre';

export function initializeDirectorDebug(windowObj = window) {
  windowObj.__directorDebug = windowObj.__directorDebug || { enabled: false, events: [] };
  windowObj.setDirectorDebug = function setDirectorDebug(enabled) {
    windowObj.__directorDebug.enabled = Boolean(enabled);
    console.log(`[DirectorDebug] ${windowObj.__directorDebug.enabled ? 'enabled' : 'disabled'}`);
  };
  windowObj.getDirectorDebugEvents = function getDirectorDebugEvents() {
    return [...(windowObj.__directorDebug.events || [])];
  };
  windowObj.clearDirectorDebugEvents = function clearDirectorDebugEvents() {
    windowObj.__directorDebug.events = [];
  };
  windowObj.__pushDirectorDebugEvent = function __pushDirectorDebugEvent(type, payload = {}) {
    const evt = { ts: new Date().toISOString(), type, ...payload };
    const store = windowObj.__directorDebug;
    store.events.push(evt);
    if (store.events.length > 300) store.events.shift();
    if (store.enabled) console.log('[DirectorDebug]', evt);
  };
}

function summarizeBgDiagnostics(events) {
  const recent = events.slice(-120);
  const count = (type) => recent.filter((e) => e.type === type).length;

  const reasons = [];
  if (count('bg-missing-generation-needed') === 0) {
    reasons.push('No missing BG events detected. Director is likely resolving to existing backgrounds.');
  }
  if (count('bg-missing-generation-needed') > 0 && count('bg-generate-start') === 0) {
    reasons.push('Missing BG detected, but generation did not start. Check handleMissingVisuals execution.');
  }
  if (count('bg-generate-start') > 0 && count('bg-generate-success') === 0) {
    if (count('bg-fallback-used') + count('bg-fallback-used-after-error') > 0) {
      reasons.push('Generation is failing upstream; fallback backgrounds are being used.');
    } else if (count('bg-generate-error') + count('bg-generate-empty') > 0) {
      reasons.push('Generation attempts are failing or returning empty results.');
    } else {
      reasons.push('Generation is in-flight or being discarded as stale.');
    }
  }
  if (count('bg-generate-stale') > 0) {
    reasons.push('Older generation requests are being discarded due to newer requests.');
  }

  if (reasons.length === 0) reasons.push('No obvious issue detected in recent events.');
  return reasons;
}

export function createBgDiagnosticsController({ useStore, windowObj = window, documentObj = document }) {
  let bgDiagTimer = null;

  function getBgDiagnosticsSnapshot() {
    const events = windowObj.getDirectorDebugEvents ? windowObj.getDirectorDebugEvents() : [];
    const recent = events.slice(-25);
    const spinner = documentObj.getElementById('vn-spinner');
    const spinnerActive = Boolean(spinner && spinner.classList.contains('active'));
    const currentBgStore = useStore.getState()?.currentBackground || '';
    const currentBgDom = documentObj.getElementById('vn-bg')?.getAttribute('src') || '';
    const generatedInManifest = Object.keys(windowObj.imageManifest?.backgrounds || {}).filter((k) => String(k).startsWith('backgrounds/generated/')).length;

    return {
      now: new Date().toISOString(),
      spinnerActive,
      currentBgStore,
      currentBgDom,
      generatedInManifest,
      directorDebugEnabled: Boolean(windowObj.__directorDebug?.enabled),
      totalDebugEvents: events.length,
      reasons: summarizeBgDiagnostics(events),
      recentEvents: recent,
    };
  }

  function renderBgDiagnosticsPanel() {
    const pre = documentObj.getElementById(BG_DIAG_PRE_ID);
    if (!pre) return;
    pre.textContent = JSON.stringify(getBgDiagnosticsSnapshot(), null, 2);
  }

  function ensureBgDiagnosticsPanel() {
    let panel = documentObj.getElementById(BG_DIAG_PANEL_ID);
    if (panel) return panel;

    panel = documentObj.createElement('div');
    panel.id = BG_DIAG_PANEL_ID;
    panel.style.cssText = 'position:fixed; top:10px; left:10px; width:min(760px, calc(100vw - 20px)); max-height:85vh; background:rgba(0,0,0,0.92); color:#d5ffd5; border:1px solid #3b4; border-radius:8px; z-index:30000; display:none; box-shadow:0 10px 25px rgba(0,0,0,0.6); font-family:Consolas, Menlo, monospace;';

    const header = documentObj.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #2a3;';
    header.innerHTML = '<strong>Background Diagnostics (F10)</strong>';

    const controls = documentObj.createElement('div');
    controls.style.cssText = 'display:flex; gap:8px;';

    const refreshBtn = documentObj.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText = 'cursor:pointer;';
    refreshBtn.onclick = () => renderBgDiagnosticsPanel();

    const clearBtn = documentObj.createElement('button');
    clearBtn.textContent = 'Clear Events';
    clearBtn.style.cssText = 'cursor:pointer;';
    clearBtn.onclick = () => {
      if (windowObj.clearDirectorDebugEvents) windowObj.clearDirectorDebugEvents();
      renderBgDiagnosticsPanel();
    };

    const closeBtn = documentObj.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'cursor:pointer;';
    closeBtn.onclick = () => toggleBgDiagnosticsPanel(false);

    controls.appendChild(refreshBtn);
    controls.appendChild(clearBtn);
    controls.appendChild(closeBtn);
    header.appendChild(controls);

    const pre = documentObj.createElement('pre');
    pre.id = BG_DIAG_PRE_ID;
    pre.style.cssText = 'margin:0; padding:10px; white-space:pre-wrap; overflow:auto; max-height:calc(85vh - 48px); font-size:12px;';

    panel.appendChild(header);
    panel.appendChild(pre);
    documentObj.body.appendChild(panel);
    return panel;
  }

  function toggleBgDiagnosticsPanel(forceOpen) {
    const panel = ensureBgDiagnosticsPanel();
    const shouldOpen = forceOpen == null ? panel.style.display === 'none' : Boolean(forceOpen);
    panel.style.display = shouldOpen ? 'block' : 'none';

    if (shouldOpen) {
      if (windowObj.setDirectorDebug) windowObj.setDirectorDebug(true);
      renderBgDiagnosticsPanel();
      if (bgDiagTimer) clearInterval(bgDiagTimer);
      bgDiagTimer = setInterval(renderBgDiagnosticsPanel, 1000);
    } else if (bgDiagTimer) {
      clearInterval(bgDiagTimer);
      bgDiagTimer = null;
    }
  }

  return { toggleBgDiagnosticsPanel };
}

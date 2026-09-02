'use strict';

const $ = id => document.getElementById(id);

const urlInput     = $('url-input');
const fetchBtn     = $('fetch-btn');
const btnLabel     = $('btn-label');
const btnSpinner   = $('btn-spinner');
const errorMsg     = $('error-msg');
const videoCard    = $('video-card');
const playlistCard = $('playlist-card');
const progressCard = $('progress-card');
const doneCard     = $('done-card');

const vThumb    = $('v-thumb');
const vDuration = $('v-duration');
const vTitle    = $('v-title');
const vChannel  = $('v-channel');
const vViews    = $('v-views');
const thumbBtn  = $('thumb-btn');
const dlBtn     = $('dl-btn');

const pThumb   = $('p-thumb');
const pCount   = $('p-count');
const pTitle   = $('p-title');
const pChannel = $('p-channel');
const pDlBtn   = $('p-dl-btn');

const progFill    = $('prog-fill');
const progPct     = $('prog-pct');
const progLabel   = $('prog-label');
const progSpeed   = $('prog-speed');
const progEta     = $('prog-eta');
const progCurrent = $('prog-current');
const doneName    = $('done-name');
const saveLink    = $('save-link');
const autoDlChk   = $('auto-dl-chk');

// Persist auto-download preference
autoDlChk.checked = localStorage.getItem('auto-dl') === '1';
autoDlChk.addEventListener('change', () => {
  localStorage.setItem('auto-dl', autoDlChk.checked ? '1' : '0');
});

// Resolution to pixel height mapping
const HEIGHT_MAP = {
  '360': 360, '480': 480, '720': 720,
  '1080': 1080, '2k': 1440, '4k': 2160, '8k': 4320,
};

// State
let currentUrl  = '';
let curFmt      = 'best';
let curQ        = '1080';
let pCurFmt     = 'best';
let pCurQ       = '1080';
let pollTimer   = null;
let currentMode = 'single';

// ── Version badge ─────────────────────────────────────────────

const versionDot  = $('version-dot');
const versionText = $('version-text');

async function fetchVersion() {
  try {
    const res  = await fetch('/api/version');
    const data = await res.json();
    const v    = data.version || '?';
    versionDot.className  = 'version-dot ' + (data.status || '');
    let label = `yt-dlp ${v}`;
    if (data.status === 'checking') label += ' (mise à jour…)';
    const next = data.next_check ? new Date(data.next_check) : null;
    if (next && data.status !== 'checking') {
      const h = Math.round((next - Date.now()) / 3600000);
      if (h > 0) label += ` · prochaine vérif. dans ${h}h`;
    }
    versionText.textContent = label;
    // Si en cours de vérif, repoll dans 5s
    if (data.status === 'checking') setTimeout(fetchVersion, 5000);
  } catch { /* silencieux */ }
}

fetchVersion();

// ── Format/quality grid handlers ──────────────────────────────

function applyFmtChange(fmt, videoQId, audioQId, qLabelId, setter) {
  setter(fmt);
  const vQ = $(videoQId);
  const aQ = $(audioQId);
  const lbl = $(qLabelId);

  if (fmt === 'best') {
    // Optimal: no quality selector
    vQ.classList.add('hidden');
    aQ.classList.add('hidden');
    lbl.classList.add('hidden');
  } else if (fmt === 'mp4' || fmt === 'mkv') {
    vQ.classList.remove('hidden');
    aQ.classList.add('hidden');
    lbl.classList.remove('hidden');
  } else if (fmt === 'mp3') {
    vQ.classList.add('hidden');
    aQ.classList.remove('hidden');
    lbl.classList.remove('hidden');
  } else { // m4a
    vQ.classList.add('hidden');
    aQ.classList.add('hidden');
    lbl.classList.add('hidden');
  }
}

function setupFmtTabs(tabsId, videoQId, audioQId, qLabelId, setter) {
  document.querySelectorAll(`#${tabsId} .fmt-tab`).forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll(`#${tabsId} .fmt-tab`).forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      applyFmtChange(tab.dataset.fmt, videoQId, audioQId, qLabelId, setter);
    });
  });
}

function setupQBtns(gridId, setter) {
  document.querySelectorAll(`#${gridId} .q-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      document.querySelectorAll(`#${gridId} .q-btn`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setter(btn.dataset.q);
    });
  });
}

setupFmtTabs('fmt-tabs', 'q-video', 'q-audio', 'q-label', f => { curFmt = f; });
setupQBtns('q-video', q => { curQ = q; });
setupQBtns('q-audio', q => { curQ = q; });

setupFmtTabs('p-fmt-tabs', 'pq-video', 'pq-audio', 'pq-label', f => { pCurFmt = f; });
setupQBtns('pq-video', q => { pCurQ = q; });
setupQBtns('pq-audio', q => { pCurQ = q; });

// ── Limit quality grid to video's actual max resolution ───────

function limitQualities(gridId, maxHeight, qSetter) {
  if (!maxHeight) return;

  let bestBtn = null;

  document.querySelectorAll(`#${gridId} .q-btn`).forEach(btn => {
    const h = HEIGHT_MAP[btn.dataset.q] || 0;
    if (h > maxHeight) {
      btn.disabled = true;
      btn.classList.remove('active');
    } else {
      btn.disabled = false;
      if (!bestBtn || h > (HEIGHT_MAP[bestBtn.dataset.q] || 0)) {
        bestBtn = btn;
      }
    }
  });

  // Auto-select best available quality
  if (bestBtn) {
    document.querySelectorAll(`#${gridId} .q-btn`).forEach(b => b.classList.remove('active'));
    bestBtn.classList.add('active');
    qSetter(bestBtn.dataset.q);
  }
}

// ── Switch to audio-only mode (SoundCloud etc.) ───────────────

function switchToAudioOnly(tabsId, videoQId, audioQId, qLabelId, fmtSetter, qSetter) {
  // Hide video format tabs (Optimal, MP4, MKV)
  const tabs = document.querySelectorAll(`#${tabsId} .fmt-tab`);
  tabs.forEach(tab => {
    const fmt = tab.dataset.fmt;
    if (fmt === 'best' || fmt === 'mp4' || fmt === 'mkv') {
      tab.classList.add('unavailable');
      tab.classList.remove('active');
    }
  });

  // Activate MP3 by default
  const mp3Tab = document.querySelector(`#${tabsId} [data-fmt="mp3"]`);
  if (mp3Tab) {
    mp3Tab.classList.add('active');
    applyFmtChange('mp3', videoQId, audioQId, qLabelId, fmtSetter);
  }

  // Auto-select 256 kbps
  const audioGrid = audioQId === 'q-audio' ? 'q-audio' : 'pq-audio';
  const btn256 = document.querySelector(`#${audioGrid} [data-q="256"]`);
  if (btn256) {
    document.querySelectorAll(`#${audioGrid} .q-btn`).forEach(b => b.classList.remove('active'));
    btn256.classList.add('active');
    qSetter('256');
  }
}

// ── Fetch info ────────────────────────────────────────────────

fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchInfo(); });

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) return;

  currentUrl = url;
  setLoading(true);
  hideAll();

  try {
    const res  = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok || data.error) { showError(data.error || 'Erreur'); return; }

    if (data.type === 'playlist') {
      currentMode = 'playlist';
      pThumb.src = data.thumbnail || '';
      pCount.textContent = `${data.count} vidéos`;
      pTitle.textContent = data.title;
      pChannel.textContent = data.channel;
      pThumb.parentElement.style.display = data.thumbnail ? '' : 'none';

      // Reset format tabs for playlist
      resetFmtTabs('p-fmt-tabs', 'pq-video', 'pq-audio', 'pq-label', f => { pCurFmt = f; });

      if (data.audio_only) {
        switchToAudioOnly('p-fmt-tabs', 'pq-video', 'pq-audio', 'pq-label',
          f => { pCurFmt = f; }, q => { pCurQ = q; });
      }

      show(playlistCard);

    } else {
      currentMode = 'single';
      vThumb.src            = data.thumbnail;
      vDuration.textContent = data.duration;
      vTitle.textContent    = data.title;
      vChannel.textContent  = data.channel;
      vViews.textContent    = data.views;
      $('v-views-sep').style.display = data.views ? '' : 'none';

      // Reset format tabs
      resetFmtTabs('fmt-tabs', 'q-video', 'q-audio', 'q-label', f => { curFmt = f; });

      if (data.audio_only) {
        switchToAudioOnly('fmt-tabs', 'q-video', 'q-audio', 'q-label',
          f => { curFmt = f; }, q => { curQ = q; });
      } else if (data.max_height) {
        // Limit quality buttons to video's actual max
        limitQualities('q-video', data.max_height, q => { curQ = q; });
      }

      show(videoCard);
    }

  } catch { showError('Serveur inaccessible — lance app.py d\'abord'); }
  finally  { setLoading(false); }
}

// Reset format tabs to default state (Optimal selected, no quality shown)
function resetFmtTabs(tabsId, videoQId, audioQId, qLabelId, setter) {
  document.querySelectorAll(`#${tabsId} .fmt-tab`).forEach(t => {
    t.classList.remove('active', 'unavailable');
  });
  const optimalTab = document.querySelector(`#${tabsId} [data-fmt="best"]`);
  if (optimalTab) optimalTab.classList.add('active');
  setter('best');
  applyFmtChange('best', videoQId, audioQId, qLabelId, setter);

  // Re-enable all quality buttons
  document.querySelectorAll(`#${videoQId} .q-btn`).forEach(b => { b.disabled = false; });
}

// ── Thumbnail ─────────────────────────────────────────────────

thumbBtn.addEventListener('click', async () => {
  thumbBtn.disabled = true;
  const orig = thumbBtn.textContent;
  thumbBtn.textContent = '...';

  try {
    const res = await fetch('/api/thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentUrl }),
    });
    if (!res.ok) { const d = await res.json(); showError(d.error); return; }
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const m    = cd.match(/filename="([^"]+)"/);
    triggerDl(URL.createObjectURL(blob), m ? m[1] : 'thumbnail.jpg');
  } catch { showError('Erreur miniature'); }
  finally  { thumbBtn.disabled = false; thumbBtn.textContent = orig; }
});

// ── Download ──────────────────────────────────────────────────

dlBtn.addEventListener('click', () => startDownload('single', curFmt, curQ));
pDlBtn.addEventListener('click', () => startDownload('playlist', pCurFmt, pCurQ));

async function startDownload(mode, fmt, quality) {
  const btn = mode === 'playlist' ? pDlBtn : dlBtn;
  btn.disabled = true;
  hideCards(progressCard, doneCard, errorMsg);
  resetProgress();
  show(progressCard);

  try {
    const res  = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentUrl, format: fmt, quality, mode }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || 'Erreur');
      hide(progressCard);
      btn.disabled = false;
      return;
    }

    poll(data.download_id, btn);

  } catch {
    showError('Serveur inaccessible');
    hide(progressCard);
    btn.disabled = false;
  }
}

// ── Poll ──────────────────────────────────────────────────────

function poll(id, btn) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`/api/progress/${id}`);
      const data = await res.json();
      if (data.error) { stopPoll(); showError(data.error); btn.disabled = false; return; }
      updateProgress(data);
      if (data.status === 'done') {
        stopPoll(); btn.disabled = false;
        showDone(id, data.filename, data.is_playlist);
      } else if (data.status === 'error') {
        stopPoll(); btn.disabled = false;
        hide(progressCard);
        showError(data.error || 'Erreur inconnue');
      }
    } catch { /* retry */ }
  }, 500);
}

function updateProgress(data) {
  const pct = Math.min(100, Math.round(data.progress || 0));
  progFill.style.width = pct + '%';
  progPct.textContent  = pct + '%';

  if (data.status === 'processing') {
    progLabel.textContent = 'Traitement...';
  } else if (data.current_title) {
    progLabel.textContent = data.current_title.length > 55
      ? data.current_title.slice(0, 55) + '…'
      : data.current_title;
  } else {
    progLabel.textContent = 'Téléchargement...';
  }

  progCurrent.textContent = (data.is_playlist && data.total > 1)
    ? `${data.current} / ${data.total} vidéos` : '';

  progSpeed.textContent = data.speed || '';
  progEta.textContent   = data.eta ? `ETA ${data.eta}` : '';
}

function showDone(id, filename, isPlaylist) {
  hide(progressCard);
  doneName.textContent = filename || '';
  saveLink.href        = `/api/file/${id}`;
  saveLink.textContent = isPlaylist ? 'Télécharger .zip' : 'Sauvegarder';
  saveLink.classList.remove('save-btn-used');
  saveLink.style.pointerEvents = '';
  saveLink.style.opacity = '';
  show(doneCard);

  if (autoDlChk.checked) {
    autoDownload(id, filename, isPlaylist);
  }
}

async function autoDownload(id, filename, isPlaylist) {
  saveLink.textContent = '...';
  saveLink.style.pointerEvents = 'none';
  saveLink.style.opacity = '0.5';
  try {
    const res = await fetch(`/api/file/${id}`);
    if (!res.ok) { saveLink.textContent = isPlaylist ? 'Télécharger .zip' : 'Sauvegarder'; return; }
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const m    = cd.match(/filename="([^"]+)"/);
    triggerDl(URL.createObjectURL(blob), m ? m[1] : filename || 'download');
    saveLink.textContent = 'Téléchargé';
    saveLink.style.opacity = '0.4';
  } catch {
    saveLink.textContent = isPlaylist ? 'Télécharger .zip' : 'Sauvegarder';
    saveLink.style.pointerEvents = '';
    saveLink.style.opacity = '';
  }
}

// ── Helpers ───────────────────────────────────────────────────

function resetProgress() {
  progFill.style.width = '0%';
  progPct.textContent  = '0%';
  progLabel.textContent = 'Démarrage...';
  progSpeed.textContent = '';
  progEta.textContent   = '';
  progCurrent.textContent = '';
}

function stopPoll() { clearInterval(pollTimer); }

function showError(msg) { errorMsg.textContent = msg; show(errorMsg); }
function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }
function hideAll() { [videoCard, playlistCard, progressCard, doneCard, errorMsg].forEach(hide); }
function hideCards(...els) { els.forEach(hide); }

function setLoading(on) {
  fetchBtn.disabled = on;
  btnLabel.classList.toggle('hidden', on);
  btnSpinner.classList.toggle('hidden', !on);
}

function triggerDl(href, filename) {
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 30000);
}

document.addEventListener('DOMContentLoaded', () => {

  // ── Mode Tabs (URL vs Search) ──
  const modeTabs = document.querySelectorAll('.mode-tab');
  const secUrl = document.getElementById('sec-url');
  const secSearch = document.getElementById('sec-search');

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => {
        t.classList.remove('active');
        t.style.borderColor = 'var(--border)';
        t.style.color = 'var(--muted)';
      });
      tab.classList.add('active');
      tab.style.borderColor = 'var(--border2)';
      tab.style.color = '#fff';

      const mode = tab.dataset.mode;
      secUrl.classList.toggle('hidden', mode !== 'url');
      secSearch.classList.toggle('hidden', mode !== 'search');
    });
  });

  // ── URL Mode ──
  const urlInput = document.getElementById('url-input');
  const fetchBtn = document.getElementById('fetch-btn');
  const btnLabel = document.getElementById('btn-label');
  const btnSpinner = document.getElementById('btn-spinner');
  const autoDlChk = document.getElementById('auto-dl-chk');

  const urlSearchResults = document.getElementById('url-search-results');

  const videoCard = document.getElementById('video-card');
  const playlistCard = document.getElementById('playlist-card');
  const progressCard = document.getElementById('progress-card');
  const progCancelBtn = document.getElementById('prog-cancel-btn');
  const doneCard = document.getElementById('done-card');
  const errorMsg = document.getElementById('error-msg');
  const backBtn = document.getElementById('back-btn');

  // Video Card Elements
  const videoThumb = document.getElementById('video-thumb');
  const videoTitle = document.getElementById('video-title');
  const videoChannel = document.getElementById('video-channel');
  const videoViews = document.getElementById('video-views');
  const videoDuration = document.getElementById('video-duration');
  const dlBtn = document.getElementById('dl-btn');
  const thumbBtn = document.getElementById('thumb-btn');

  // Playlist Card Elements
  const pThumb = document.getElementById('p-thumb');
  const pTitle = document.getElementById('p-title');
  const pChannel = document.getElementById('p-channel');
  const pCount = document.getElementById('p-count');
  const pDlBtn = document.getElementById('p-dl-btn');

  let currentUrl = '';
  let curFmt = 'best';
  let curQ = '1080';
  let pCurFmt = 'mp4';
  let pCurQ = '1080';
  let channelScope = 'all';
  let datePreset = 'now-1year';

  const STATE_KEY = 'ytdown_state';
  function saveSearchState(patch) {
    YTPersist.save(STATE_KEY, patch);
  }

  const DOWNLOAD_KEY = 'ytdown_download';
  let activeDownloadId = null;
  let activeStartBtn = null;

  fetchBtn.addEventListener('click', runFetch);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') runFetch(); });

  function isUrl(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  }

  async function runFetch() {
    const raw = urlInput.value.trim();
    if (!raw) return;

    hideAllCards();
    hide(urlSearchResults);
    setLoading(true);

    // Texte simple (pas un lien) → recherche YouTube par mot-clé
    if (!isUrl(raw)) {
      await runUrlSearch(raw);
      setLoading(false);
      return;
    }

    currentUrl = raw;

    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(raw)}`);
      const data = await res.json();

      if (!res.ok || data.error) {
        showError(data.error || 'Erreur lors de l’analyse');
        return;
      }

      if (data.type === 'spotify') {
        // Les liens Spotify se téléchargent uniquement depuis la page SpotiFLAC
        // dédiée (sources multiples, qualité, réglages) : pas de copie limitée ici.
        window.location.href = `/spotify?url=${encodeURIComponent(raw)}`;
      } else if (data.type === 'playlist') {
        renderPlaylistCard(data);
        if (autoDlChk.checked) pDlBtn.click();
      } else {
        renderVideoCard(data);
        if (autoDlChk.checked) dlBtn.click();
      }
    } catch {
      showError('Serveur inaccessible');
    } finally {
      setLoading(false);
    }
  }

  async function runUrlSearch(q) {
    try {
      const res = await fetch(`/api/search?type=youtube&q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        showError(data.error || 'Erreur de recherche');
        return;
      }
      renderGrid(urlSearchResults, data.results);
      show(urlSearchResults);
      saveSearchState({ context: 'url', query: q, results: data.results });
    } catch {
      showError('Serveur inaccessible');
    }
  }

  function renderVideoCard(data) {
    videoThumb.src = data.thumbnail || '';
    videoTitle.textContent = data.title || '';
    videoChannel.textContent = data.channel || '';
    videoViews.textContent = data.views || '';
    videoDuration.textContent = data.duration || '';
    applyAudioOnly(!!data.audio_only);
    show(videoCard);
  }

  // Source audio uniquement (SoundCloud, Bandcamp...) : ni vidéo ni résolution,
  // ni FLAC (le flux source est déjà compressé) — seulement MP3 et M4A (AAC).
  const hiddenWhenAudioOnly = new Set(['mp4', 'mkv', 'best', 'flac']);
  function applyAudioOnly(isAudioOnly) {
    document.querySelectorAll('#fmt-tabs .fmt-tab').forEach((chip) => {
      const hide = isAudioOnly && hiddenWhenAudioOnly.has(chip.dataset.fmt);
      chip.classList.toggle('hidden', hide);
    });
    document.getElementById('quality-section').style.display = isAudioOnly ? 'none' : '';
    if (isAudioOnly && hiddenWhenAudioOnly.has(curFmt)) {
      const mp3Tab = document.querySelector('#fmt-tabs .fmt-tab[data-fmt="mp3"]');
      if (mp3Tab) mp3Tab.click();
    }
  }

  function renderPlaylistCard(data) {
    pThumb.src = data.thumbnail || '';
    pTitle.textContent = data.title || '';
    pChannel.textContent = data.channel || '';
    pCount.textContent = `${data.count} éléments`;
    document.getElementById('channel-scope-section').classList.toggle('hidden', !data.is_channel);
    resetChannelScopeUI();
    show(playlistCard);
  }

  // ── Choix de format/qualité/portée pour une playlist ou une chaîne ──
  document.querySelectorAll('#p-fmt-tabs .fmt-tab').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#p-fmt-tabs .fmt-tab').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      pCurFmt = chip.dataset.fmt;
      document.getElementById('p-quality-section').style.display = (pCurFmt === 'mp4') ? '' : 'none';
    });
  });

  document.querySelectorAll('#p-q-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#p-q-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pCurQ = btn.dataset.q;
    });
  });

  const scopeRangeFields = document.getElementById('scope-range-fields');
  const scopeDateFields = document.getElementById('scope-date-fields');
  const dateCustomInput = document.getElementById('date-custom');

  document.querySelectorAll('#scope-tabs .fmt-tab').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#scope-tabs .fmt-tab').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      channelScope = chip.dataset.scope;
      scopeRangeFields.classList.toggle('hidden', channelScope !== 'range');
      scopeDateFields.classList.toggle('hidden', channelScope !== 'date');
    });
  });

  document.querySelectorAll('#date-preset-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#date-preset-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      datePreset = btn.dataset.preset;
      dateCustomInput.classList.toggle('hidden', datePreset !== 'custom');
    });
  });

  function resetChannelScopeUI() {
    channelScope = 'all';
    document.querySelectorAll('#scope-tabs .fmt-tab').forEach(c => c.classList.toggle('active', c.dataset.scope === 'all'));
    hide(scopeRangeFields);
    hide(scopeDateFields);
  }

  // ── Format Selection Chips ──
  document.querySelectorAll('#fmt-tabs .fmt-tab').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#fmt-tabs .fmt-tab').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      curFmt = chip.dataset.fmt;
      document.getElementById('quality-section').style.display = (curFmt === 'mp3' || curFmt === 'flac' || curFmt === 'm4a') ? 'none' : 'block';
    });
  });

  document.querySelectorAll('#q-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#q-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      curQ = btn.dataset.q;
    });
  });

  // ── Music Search Mode ──
  const musicInput = document.getElementById('music-input');
  const musicSearchBtn = document.getElementById('music-search-btn');
  const musicBtnLabel = document.getElementById('music-btn-label');
  const musicBtnSpinner = document.getElementById('music-btn-spinner');
  const musicResults = document.getElementById('music-results');
  const musicError = document.getElementById('music-error');

  let musicSource = 'youtube';

  document.querySelectorAll('.src-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.src-chip').forEach(c => {
        c.classList.remove('active');
        c.style.border = '1px solid var(--border2)';
        c.style.background = 'transparent';
        c.style.color = 'var(--muted2)';
      });
      chip.classList.add('active');
      chip.style.border = '1px solid #fff';
      chip.style.background = '#fff';
      chip.style.color = '#000';
      musicSource = chip.dataset.src;

      // Change de filtre → ré-exécute directement la même recherche
      if (musicInput.value.trim()) runMusicSearch();
    });
  });

  musicSearchBtn.addEventListener('click', runMusicSearch);
  musicInput.addEventListener('keydown', e => { if (e.key === 'Enter') runMusicSearch(); });

  async function runMusicSearch() {
    const q = musicInput.value.trim();
    if (!q) return;

    // Si l'utilisateur colle un lien Spotify directement dans la recherche musique
    if (q.includes('spotify.com/')) {
      urlInput.value = q;
      document.getElementById('tab-url-btn').click();
      runFetch();
      return;
    }

    setMusicLoading(true);
    hide(musicError);
    musicResults.innerHTML = '';

    try {
      const res = await fetch(`/api/search?type=${musicSource}&q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        musicError.textContent = data.error || 'Erreur de recherche';
        show(musicError);
        return;
      }

      renderGrid(musicResults, data.results);
      saveSearchState({ context: 'music', query: q, source: musicSource, results: data.results });
    } catch {
      musicError.textContent = 'Serveur inaccessible';
      show(musicError);
    } finally {
      setMusicLoading(false);
    }
  }

  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

  function renderGrid(container, results) {
    container.innerHTML = '';
    (results || []).forEach(item => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'padding: 12px; cursor: pointer; transition: border-color 0.15s;';
      card.innerHTML = `
        <div class="thumb-wrap" style="aspect-ratio: 16/9; margin-bottom: 8px;">
          <img src="${item.thumbnail || ''}" style="width:100%; height:100%; object-fit:cover;">
          <button type="button" class="quick-dl-btn" title="Télécharger (qualité optimale)">${ICON_DOWNLOAD}</button>
        </div>
        <h4 style="font-size: 13px; font-weight: 600; line-height: 1.3; height: 2.6em; overflow: hidden; margin-bottom: 4px;">${item.title}</h4>
        <p style="font-size: 11px; color: var(--muted);">${item.artist || item.channel || ''}</p>
      `;
      card.addEventListener('click', () => {
        urlInput.value = item.url;
        document.getElementById('tab-url-btn').click();
        runFetch();
      });
      card.querySelector('.quick-dl-btn').addEventListener('click', (event) => {
        event.stopPropagation();
        const btn = event.currentTarget;
        btn.disabled = true;
        window.DLQueue.quickDownloadYoutube(item.url, {
          title: item.title, subtitle: item.artist || item.channel || '', thumbnail: item.thumbnail,
        }).finally(() => { btn.disabled = false; });
      });
      container.appendChild(card);
    });
  }

  // ── Downloads & Polling ──
  dlBtn.addEventListener('click', () => startDownload('single', curFmt, curQ));
  pDlBtn.addEventListener('click', () => startDownload('playlist', pCurFmt, pCurQ));

  async function startDownload(mode, fmt, quality) {
    const btn = mode === 'playlist' ? pDlBtn : dlBtn;
    btn.disabled = true;
    hideAllCards();
    resetProgress();
    show(progressCard);

    const queueEntry = window.DLQueue.add({
      service: 'ytdown', autoSave: autoDlChk.checked,
      title: mode === 'playlist' ? pTitle.textContent : videoTitle.textContent,
      subtitle: mode === 'playlist' ? pChannel.textContent : videoChannel.textContent,
      thumbnail: mode === 'playlist' ? pThumb.src : videoThumb.src,
    });

    const body = { url: currentUrl, format: fmt, quality, mode };
    if (mode === 'playlist') {
      body.channel_scope = channelScope;
      if (channelScope === 'range') {
        const start = parseInt(document.getElementById('range-start').value, 10) || 1;
        const end = parseInt(document.getElementById('range-end').value, 10) || start;
        body.range_start = start;
        body.range_end = end;
      } else if (channelScope === 'date') {
        body.date_after = datePreset === 'custom'
          ? (dateCustomInput.value || '').replace(/-/g, '')
          : datePreset;
      }
    }

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        window.DLQueue.fail(queueEntry, data.error || 'Erreur');
        showError(data.error || 'Erreur');
        hide(progressCard);
        btn.disabled = false;
        return;
      }
      activeDownloadId = data.download_id;
      activeStartBtn = btn;
      window.DLQueue.attach(queueEntry, data.download_id);
      YTPersist.save(DOWNLOAD_KEY, { downloadId: data.download_id, mode });
      pollProgress(data.download_id, btn);
    } catch {
      window.DLQueue.fail(queueEntry, 'Serveur inaccessible');
      showError('Serveur inaccessible');
      hide(progressCard);
      btn.disabled = false;
    }
  }

  let pollTimer = null;

  function clearActiveDownload() {
    activeDownloadId = null;
    activeStartBtn = null;
  }

  function pollProgress(id, btn) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/progress/${id}`);
        const data = await res.json();
        if (data.error) {
          stopPoll();
          showError(data.error);
          if (btn) btn.disabled = false;
          YTPersist.clear(DOWNLOAD_KEY);
          clearActiveDownload();
          return;
        }

        updateProgressUI(data);

        if (data.status === 'done') {
          stopPoll();
          if (btn) btn.disabled = false;
          showDone(id, data.filename, data.is_playlist);
          YTPersist.clear(DOWNLOAD_KEY);
          clearActiveDownload();
        } else if (data.status === 'error') {
          stopPoll();
          if (btn) btn.disabled = false;
          hide(progressCard);
          showError(data.error || 'Erreur lors du traitement');
          YTPersist.clear(DOWNLOAD_KEY);
          clearActiveDownload();
        } else if (data.status === 'cancelled') {
          stopPoll();
          if (btn) btn.disabled = false;
          hide(progressCard);
          YTPersist.clear(DOWNLOAD_KEY);
          clearActiveDownload();
        }
      } catch { /* retry */ }
    }, 600);
  }

  progCancelBtn.addEventListener('click', async () => {
    if (!activeDownloadId) return;
    progCancelBtn.disabled = true;
    await window.DLQueue.cancelById(activeDownloadId);
    stopPoll();
    hide(progressCard);
    if (activeStartBtn) activeStartBtn.disabled = false;
    YTPersist.clear(DOWNLOAD_KEY);
    clearActiveDownload();
    progCancelBtn.disabled = false;
  });

  function updateProgressUI(data) {
    const pct = Math.min(100, Math.round(data.progress || 0));
    document.getElementById('prog-fill').style.width = pct + '%';
    document.getElementById('prog-pct').textContent = pct + '%';

    const progLabel = document.getElementById('prog-label');
    const progCurrent = document.getElementById('prog-current');

    if (data.status === 'processing') {
      progLabel.textContent = 'Traitement...';
    } else if (data.current_title) {
      progLabel.textContent = data.current_title;
    } else {
      progLabel.textContent = 'Téléchargement...';
    }

    progCurrent.textContent = (data.total > 1) ? `Fichier ${data.current} / ${data.total}` : '';
    document.getElementById('prog-speed').textContent = data.speed || '';
    document.getElementById('prog-eta').textContent = data.eta ? `ETA ${data.eta}` : '';
  }

  function showDone(id, filename, isPlaylist) {
    hide(progressCard);
    const doneName = document.getElementById('done-name');
    const saveLink = document.getElementById('save-link');

    doneName.textContent = filename || '';
    saveLink.textContent = isPlaylist ? 'Télécharger (.zip)' : 'Sauvegarder';
    saveLink.classList.remove('loading');

    // Le zip est assemblé côté serveur avant le premier octet de réponse :
    // une navigation <a href> classique laisse la page muette pendant ce
    // temps. On passe par fetch()+blob pour afficher un spinner pendant
    // l'attente. Pour un fichier unique déjà sur disque (send_file, pas
    // d'attente notable), on garde la navigation native (streaming, pas de
    // blob géant en mémoire).
    if (isPlaylist) {
      saveLink.removeAttribute('href');
      saveLink.onclick = (e) => { e.preventDefault(); downloadZipWithSpinner(saveLink, id, filename); };
    } else {
      saveLink.href = `/api/file/${id}`;
      saveLink.onclick = null;
    }
    show(doneCard);
  }

  async function downloadZipWithSpinner(link, id, filename) {
    if (link.classList.contains('loading')) return;
    const originalLabel = link.textContent;
    link.classList.add('loading');
    link.innerHTML = '<span class="spinner"></span> Préparation du zip...';
    try {
      const res = await fetch(`/api/file/${id}`);
      if (!res.ok) throw new Error('Échec de la récupération du fichier');
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = /filename="?([^";]+)"?/.exec(cd);
      const saveName = match ? match[1] : (filename || 'download.zip');
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = saveName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      link.textContent = originalLabel;
    } catch {
      showError('Impossible de récupérer le fichier');
      link.textContent = originalLabel;
    } finally {
      link.classList.remove('loading');
    }
  }

  // ── Helpers ──
  function resetProgress() {
    document.getElementById('prog-fill').style.width = '0%';
    document.getElementById('prog-pct').textContent = '0%';
    document.getElementById('prog-label').textContent = 'Démarrage...';
    document.getElementById('prog-current').textContent = '';
    document.getElementById('prog-speed').textContent = '';
    document.getElementById('prog-eta').textContent = '';
  }

  function stopPoll() { if (pollTimer) clearInterval(pollTimer); }
  function showError(msg) { errorMsg.textContent = msg; show(errorMsg); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function hideAllCards() { [videoCard, playlistCard, progressCard, doneCard, errorMsg, urlSearchResults, backBtn].forEach(hide); }

  // ── Bouton retour : visible dès qu'une carte résultat/progression/terminé
  // est affichée, ramène à l'état de recherche initial sans recharger la
  // page. Le téléchargement en cours continue côté serveur (resumable via
  // YTPersist au prochain chargement) — "retour" arrête juste le suivi UI.
  document.querySelectorAll('#video-card, #playlist-card, #progress-card, #done-card').forEach((card) => {
    const observer = new MutationObserver(() => {
      const anyVisible = [videoCard, playlistCard, progressCard, doneCard].some((c) => !c.classList.contains('hidden'));
      backBtn.classList.toggle('hidden', !anyVisible);
    });
    observer.observe(card, { attributes: true, attributeFilter: ['class'] });
  });
  backBtn.addEventListener('click', () => {
    stopPoll();
    hideAllCards();
    urlInput.value = '';
    urlInput.focus();
  });

  function setLoading(on) {
    fetchBtn.disabled = on;
    btnLabel.classList.toggle('hidden', on);
    btnSpinner.classList.toggle('hidden', !on);
  }

  function setMusicLoading(on) {
    musicSearchBtn.disabled = on;
    musicBtnLabel.classList.toggle('hidden', on);
    musicBtnSpinner.classList.toggle('hidden', !on);
  }

  // ── Recherche restaurée uniquement lors d'un retour arrière du navigateur
  // (pas sur un simple rechargement ni une arrivée directe sur la page) ──
  function restoreSearchState() {
    if (!YTPersist.isBackForward()) return;
    const state = YTPersist.load(STATE_KEY);
    if (!state || !state.results) return;

    if (state.context === 'music') {
      document.getElementById('tab-search-btn').click();
      musicInput.value = state.query || '';
      musicSource = state.source || 'youtube';
      document.querySelectorAll('.src-chip').forEach((chip) => {
        const active = chip.dataset.src === musicSource;
        chip.classList.toggle('active', active);
        chip.style.border = active ? '1px solid #fff' : '1px solid var(--border2)';
        chip.style.background = active ? '#fff' : 'transparent';
        chip.style.color = active ? '#000' : 'var(--muted2)';
      });
      renderGrid(musicResults, state.results);
    } else if (state.context === 'url') {
      urlInput.value = state.query || '';
      renderGrid(urlSearchResults, state.results);
      show(urlSearchResults);
    }
  }

  restoreSearchState();

  // ── Le téléchargement continue côté serveur même après un F5 : on retrouve
  // sa progression s'il tourne encore, sans rien afficher s'il est déjà fini
  // ou en erreur (pour ne pas faire réapparaître un vieux résultat) ──
  async function resumeActiveDownload() {
    const state = YTPersist.load(DOWNLOAD_KEY);
    if (!state || !state.downloadId) return;
    try {
      const res = await fetch(`/api/progress/${state.downloadId}`);
      const data = await res.json();
      if (data.error || data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
        YTPersist.clear(DOWNLOAD_KEY);
        return;
      }
      const btn = state.mode === 'playlist' ? pDlBtn : dlBtn;
      hideAllCards();
      resetProgress();
      updateProgressUI(data);
      show(progressCard);
      btn.disabled = true;
      activeDownloadId = state.downloadId;
      activeStartBtn = btn;
      pollProgress(state.downloadId, btn);
    } catch {
      /* pas grave : au pire on rate la reprise, le téléchargement continue quand même côté serveur */
    }
  }
  resumeActiveDownload();

  // ── Indicateur de version yt-dlp (auto-mis à jour côté serveur) ──
  async function loadVersionBadge() {
    try {
      const res = await fetch('/api/version');
      const data = await res.json();
      const badge = document.getElementById('version-badge');
      const dot = badge.querySelector('.version-dot');
      const text = document.getElementById('v-text');
      dot.classList.remove('ok', 'checking', 'error');
      dot.classList.add(['ok', 'checking', 'error'].includes(data.status) ? data.status : 'ok');
      text.textContent = data.version ? `yt-dlp ${data.version}` : 'yt-dlp';
      badge.title = data.last_check ? `Dernière vérification : ${new Date(data.last_check).toLocaleString('fr-FR')}` : 'Vérification à venir';
      badge.classList.remove('hidden');
    } catch {
      /* silencieux : l'indicateur reste caché si l'API n'est pas joignable */
    }
  }
  loadVersionBadge();

});

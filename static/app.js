document.addEventListener('DOMContentLoaded', () => {

  // ── Mode Tabs (URL vs Search) ──
  const modeTabs = document.querySelectorAll('.mode-tab');
  const secUrl = document.getElementById('sec-url');
  const secSearch = document.getElementById('sec-search');

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

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
  let curBitrate = '320';
  let pCurFmt = 'mp4';
  let pCurQ = '1080';
  let pCurBitrate = '320';
  let currentAudioOnly = false;
  let playlistAudioOnly = false;
  let channelScope = 'all';
  let datePreset = 'now-1year';

  // Page « fixe » : format/qualité choisis, fiche analysée et provenance
  // (résultats de recherche) survivent à un changement de page ou un F5.
  const PREFS_KEY = 'ytdown_prefs';
  const CARD_KEY = 'ytdown_card';
  let lastCard = null;
  let originContext = null;

  function savePrefs() {
    YTPersist.save(PREFS_KEY, { fmt: curFmt, q: curQ, bitrate: curBitrate, pFmt: pCurFmt, pQ: pCurQ, pBitrate: pCurBitrate });
  }
  document.addEventListener('click', (event) => {
    const t = event.target;
    if (event.isTrusted && t && t.closest && t.closest('#fmt-tabs, #q-grid, #audio-q-grid, #p-fmt-tabs, #p-q-grid, #p-audio-q-grid')) savePrefs();
  });

  const STATE_KEY = 'ytdown_state';
  function saveSearchState(patch) {
    YTPersist.save(STATE_KEY, patch);
  }

  const DOWNLOAD_KEY = 'ytdown_download';
  let activeDownloadId = null;
  let activeStartBtn = null;
  const navigation = YTServiceHistory.create('ytdown', renderHistoryView);

  fetchBtn.addEventListener('click', runFetch);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') runFetch(); });

  function isUrl(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  }

  async function runFetch(fromResult) {
    const raw = urlInput.value.trim();
    if (!raw) return;
    if (fromResult !== true) originContext = null;

    hideAllCards();
    YTPersist.clear(CARD_KEY);
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
        const saved = { kind: 'playlist', url: raw, data, origin: originContext };
        YTPersist.save(CARD_KEY, saved);
        navigation.push('detail', { card: saved });
      } else {
        renderVideoCard(data);
        const saved = { kind: 'video', url: raw, data, origin: originContext };
        YTPersist.save(CARD_KEY, saved);
        navigation.push('detail', { card: saved });
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
      const search = { context: 'url', query: q, results: data.results };
      saveSearchState(search);
      navigation.push('search', { search });
      show(backBtn);
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
    currentAudioOnly = isAudioOnly;
    document.querySelectorAll('#fmt-tabs .fmt-tab').forEach((chip) => {
      const hide = isAudioOnly && hiddenWhenAudioOnly.has(chip.dataset.fmt);
      chip.classList.toggle('hidden', hide);
    });
    if (isAudioOnly && hiddenWhenAudioOnly.has(curFmt)) {
      const mp3Tab = document.querySelector('#fmt-tabs .fmt-tab[data-fmt="mp3"]');
      if (mp3Tab) mp3Tab.click();
    }
    updateVideoFormatUI();
  }

  function updateVideoFormatUI() {
    document.getElementById('quality-section').classList.toggle('hidden', currentAudioOnly || !['mp4', 'mkv'].includes(curFmt));
    document.getElementById('audio-quality-section').classList.toggle('hidden', curFmt !== 'mp3');
  }

  function updatePlaylistFormatUI() {
    document.querySelectorAll('#p-fmt-tabs .fmt-tab').forEach((chip) => {
      chip.classList.toggle('hidden', playlistAudioOnly && chip.dataset.fmt !== 'mp3');
    });
    document.getElementById('p-quality-section').classList.toggle('hidden', playlistAudioOnly || pCurFmt !== 'mp4');
    document.getElementById('p-audio-quality-section').classList.toggle('hidden', pCurFmt !== 'mp3');
  }

  function renderPlaylistCard(data) {
    pThumb.src = data.thumbnail || '';
    pTitle.textContent = data.title || '';
    pChannel.textContent = data.channel || '';
    pCount.textContent = `${data.count} éléments`;
    playlistAudioOnly = !!data.audio_only;
    if (playlistAudioOnly && pCurFmt !== 'mp3') document.querySelector('#p-fmt-tabs .fmt-tab[data-fmt="mp3"]').click();
    updatePlaylistFormatUI();
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
      updatePlaylistFormatUI();
    });
  });

  document.querySelectorAll('#p-q-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#p-q-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pCurQ = btn.dataset.q;
    });
  });
  document.querySelectorAll('#p-audio-q-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#p-audio-q-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pCurBitrate = btn.dataset.q;
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
      updateVideoFormatUI();
    });
  });

  document.querySelectorAll('#q-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#q-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      curQ = btn.dataset.q;
    });
  });
  document.querySelectorAll('#audio-q-grid .q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#audio-q-grid .q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      curBitrate = btn.dataset.q;
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
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
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
      const search = { context: 'music', query: q, source: musicSource, results: data.results };
      saveSearchState(search);
      navigation.push('search', { search });
      show(backBtn);
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
      const card = document.createElement('article');
      card.className = 'card search-card';
      const thumb = document.createElement('div');
      thumb.className = 'thumb-wrap';
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      try {
        const source = new URL(item.thumbnail || '', window.location.href);
        if (['http:', 'https:'].includes(source.protocol)) image.src = source.href;
      } catch { /* pas de miniature exploitable */ }
      const quickButton = document.createElement('button');
      quickButton.type = 'button';
      quickButton.className = 'quick-dl-btn';
      quickButton.title = 'Télécharger en qualité optimale';
      quickButton.setAttribute('aria-label', `Télécharger ${item.title || 'ce résultat'}`);
      quickButton.innerHTML = ICON_DOWNLOAD;
      thumb.append(image, quickButton);
      const content = document.createElement('div');
      content.className = 'search-card-content';
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'search-card-open';
      openButton.textContent = item.title || 'Sans titre';
      const subtitle = document.createElement('p');
      subtitle.textContent = item.artist || item.channel || '';
      content.append(openButton, subtitle);
      card.append(thumb, content);
      card.addEventListener('click', () => {
        originContext = container === musicResults ? 'music' : 'url';
        urlInput.value = item.url;
        document.getElementById('tab-url-btn').click();
        runFetch(true);
      });
      quickButton.addEventListener('click', (event) => {
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
  dlBtn.addEventListener('click', () => startDownload('single', curFmt, curFmt === 'mp3' ? curBitrate : curQ));
  pDlBtn.addEventListener('click', () => startDownload('playlist', pCurFmt, pCurFmt === 'mp3' ? pCurBitrate : pCurQ));

  thumbBtn.addEventListener('click', async () => {
    if (!currentUrl) return;
    thumbBtn.disabled = true;
    try {
      await window.DLQueue.downloadViaApi('/api/thumbnail', { url: currentUrl }, 'thumbnail.jpg');
    } catch (e) {
      showError(e.message || 'Miniature introuvable');
    } finally {
      thumbBtn.disabled = false;
    }
  });

  async function startDownload(mode, fmt, quality) {
    const btn = mode === 'playlist' ? pDlBtn : dlBtn;
    lastCard = mode === 'playlist' ? playlistCard : videoCard;
    btn.disabled = true;
    hideAllCards();
    resetProgress();
    show(progressCard);
    navigation.push('progress');

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
        if (navigation.current().view !== 'progress') { btn.disabled = false; return; }
        showError(data.error || 'Erreur');
        backToCard();
        navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
        btn.disabled = false;
        return;
      }
      activeDownloadId = data.download_id;
      activeStartBtn = btn;
      window.DLQueue.attach(queueEntry, data.download_id);
      YTPersist.save(DOWNLOAD_KEY, { downloadId: data.download_id, mode });
      if (navigation.current().view !== 'progress') return;
      navigation.replace('progress', { downloadId: data.download_id, mode });
      pollProgress(data.download_id, btn);
    } catch {
      window.DLQueue.fail(queueEntry, 'Serveur inaccessible');
      if (navigation.current().view !== 'progress') { btn.disabled = false; return; }
      showError('Serveur inaccessible');
      backToCard();
      navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
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
        if (navigation.current().view !== 'progress') return;
        if (data.error) {
          stopPoll();
          renderHistoryView('detail', { card: YTPersist.load(CARD_KEY) });
          navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
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
          navigation.replace('done', { downloadId: id, filename: data.filename, isPlaylist: data.is_playlist });
          YTPersist.clear(DOWNLOAD_KEY);
          clearActiveDownload();
        } else if (data.status === 'error') {
          stopPoll();
          if (btn) btn.disabled = false;
          renderHistoryView('detail', { card: YTPersist.load(CARD_KEY) });
          navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
          showError(data.error || 'Erreur lors du traitement');
          YTPersist.clear(DOWNLOAD_KEY);
          clearActiveDownload();
        } else if (data.status === 'cancelled') {
          stopPoll();
          if (btn) btn.disabled = false;
          renderHistoryView('detail', { card: YTPersist.load(CARD_KEY) });
          navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
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
    backToCard();
    navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
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

    // Le zip est streamé côté serveur (premier octet quasi immédiat), mais
    // fetch()+blob permet d'afficher un spinner pendant que le navigateur
    // met le fichier en mémoire. Pour un fichier unique déjà sur disque
    // (send_file, pas d'attente notable), on garde la navigation native
    // (streaming, pas de blob géant en mémoire).
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
      if (res.status === 404) throw new Error('Fichier expiré côté serveur — relance le téléchargement');
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
    } catch (e) {
      // « Failed to fetch » = TypeError natif du navigateur : la connexion
      // est morte. Le serveur garde le fichier 5 min après le dernier envoi,
      // recliquer le bouton retente donc le transfert.
      const msg = (e && e.message) || '';
      showError(/failed to fetch|load failed|networkerror/i.test(msg)
        ? 'Connexion au serveur perdue — vérifie que l’app tourne, puis réessaie'
        : (msg || 'Impossible de récupérer le fichier'));
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
  function showError(msg) {
    errorMsg.textContent = msg;
    show(errorMsg);
    if (navigation.current().view !== 'home') show(backBtn);
  }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function hideAllCards() { [videoCard, playlistCard, progressCard, doneCard, errorMsg, urlSearchResults, backBtn].forEach(hide); }
  // Après une erreur ou une annulation, on revient à la fiche (réglages
  // intacts) au lieu d'une page vide où il faudrait tout ré-analyser.
  function backToCard() {
    hide(progressCard);
    if (!lastCard) return;
    const filled = lastCard === playlistCard ? pTitle.textContent : videoTitle.textContent;
    if (filled) show(lastCard);
  }

  // Le bouton Retour utilise le même historique que celui du navigateur.
  document.querySelectorAll('#video-card, #playlist-card, #progress-card, #done-card').forEach((card) => {
    const observer = new MutationObserver(() => {
      backBtn.classList.toggle('hidden', navigation.current().view === 'home');
    });
    observer.observe(card, { attributes: true, attributeFilter: ['class'] });
  });
  backBtn.addEventListener('click', () => navigation.back());

  function renderHistoryView(view, state = {}) {
    stopPoll();
    hideAllCards();
    if (view !== 'progress') {
      dlBtn.disabled = false;
      pDlBtn.disabled = false;
      clearActiveDownload();
    }
    if (view === 'home') {
      document.getElementById('tab-url-btn').click();
      urlInput.value = '';
      originContext = null;
    } else if (view === 'search') {
      const search = state.search || YTPersist.load(STATE_KEY);
      if (search) restoreSearchState(search);
    } else if (view === 'detail') {
      restoreCard(state.card || YTPersist.load(CARD_KEY));
    } else if (view === 'progress') {
      const saved = YTPersist.load(CARD_KEY);
      if (saved) { restoreCard(saved); hideAllCards(); }
      resetProgress();
      show(progressCard);
      resumeActiveDownload();
    } else if (view === 'done' && state.downloadId) {
      showDone(state.downloadId, state.filename, state.isPlaylist);
    }
    backBtn.classList.toggle('hidden', view === 'home');
  }

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
  function restoreSearchState(state = YTPersist.load(STATE_KEY)) {
    if (!state || !state.results) return;

    if (state.context === 'music') {
      document.getElementById('tab-search-btn').click();
      musicInput.value = state.query || '';
      musicSource = state.source || 'youtube';
      document.querySelectorAll('.src-chip').forEach((chip) => {
        const active = chip.dataset.src === musicSource;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', String(active));
      });
      renderGrid(musicResults, state.results);
    } else if (state.context === 'url') {
      urlInput.value = state.query || '';
      renderGrid(urlSearchResults, state.results);
      show(urlSearchResults);
    }
  }

  restoreSearchState();

  function restorePrefs() {
    const p = YTPersist.load(PREFS_KEY);
    if (!p) return;
    [['#fmt-tabs .fmt-tab', 'fmt', p.fmt], ['#q-grid .q-btn', 'q', p.q],
     ['#audio-q-grid .q-btn', 'q', p.bitrate],
     ['#p-fmt-tabs .fmt-tab', 'fmt', p.pFmt], ['#p-q-grid .q-btn', 'q', p.pQ],
     ['#p-audio-q-grid .q-btn', 'q', p.pBitrate]].forEach(([sel, key, val]) => {
      if (!val) return;
      const el = Array.from(document.querySelectorAll(sel)).find((b) => b.dataset[key] === val);
      if (el && !el.classList.contains('active')) el.click();
    });
  }

  function restoreCard(saved = YTPersist.load(CARD_KEY)) {
    if (!saved || !saved.data) return;
    YTPersist.save(CARD_KEY, saved);
    currentUrl = saved.url || '';
    originContext = saved.origin || null;
    document.getElementById('tab-url-btn').click();
    urlInput.value = saved.url || '';
    hideAllCards();
    if (saved.kind === 'playlist') {
      lastCard = playlistCard;
      renderPlaylistCard(saved.data);
    } else {
      lastCard = videoCard;
      renderVideoCard(saved.data);
    }
  }

  restorePrefs();
  const savedCard = YTPersist.load(CARD_KEY);
  const savedDownload = YTPersist.load(DOWNLOAD_KEY);
  if (navigation.current().view === 'home') {
    if (savedCard) navigation.push('detail', { card: savedCard });
    if (savedDownload?.downloadId) navigation.push('progress', savedDownload);
  }
  renderHistoryView(navigation.current().view, navigation.current());

  // ── Le téléchargement continue côté serveur même après un F5 : on retrouve
  // sa progression s'il tourne encore, sans rien afficher s'il est déjà fini
  // ou en erreur (pour ne pas faire réapparaître un vieux résultat) ──
  async function resumeActiveDownload() {
    if (navigation.current().view !== 'progress') return;
    const state = navigation.current().downloadId ? navigation.current() : YTPersist.load(DOWNLOAD_KEY);
    if (!state || !state.downloadId) return;
    try {
      const res = await fetch(`/api/progress/${state.downloadId}`);
      const data = await res.json();
      if (navigation.current().view !== 'progress') return;
      if (data.status === 'done') {
        showDone(state.downloadId, data.filename, data.is_playlist);
        navigation.replace('done', { downloadId: state.downloadId, filename: data.filename, isPlaylist: data.is_playlist });
        YTPersist.clear(DOWNLOAD_KEY);
        return;
      }
      if (data.error || data.status === 'error' || data.status === 'cancelled') {
        YTPersist.clear(DOWNLOAD_KEY);
        renderHistoryView('detail', { card: YTPersist.load(CARD_KEY) });
        navigation.replace('detail', { card: YTPersist.load(CARD_KEY) });
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

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('deemix-url');
  const analyseButton = document.getElementById('deemix-analyse-btn');
  const analyseLabel = document.getElementById('deemix-analyse-label');
  const analyseSpinner = document.getElementById('deemix-analyse-spinner');
  const errorBox = document.getElementById('deemix-error');
  const card = document.getElementById('deemix-card');
  const coverBtn = document.getElementById('deemix-cover-btn');
  const progressCard = document.getElementById('deemix-progress');
  const progressCancelBtn = document.getElementById('deemix-progress-cancel');
  const doneCard = document.getElementById('deemix-done');
  const downloadButton = document.getElementById('deemix-download-btn');
  const tracks = document.getElementById('deemix-tracks');
  const searchInput = document.getElementById('deemix-search');
  const searchButton = document.getElementById('deemix-search-btn');
  const searchLabel = document.getElementById('deemix-search-label');
  const searchSpinner = document.getElementById('deemix-search-spinner');
  const searchResults = document.getElementById('deemix-results');
  const searchSummary = document.getElementById('deemix-search-summary');
  const autoDlChk = document.getElementById('deemix-auto-dl');
  const backBtn = document.getElementById('deemix-back-btn');

  let deemixData = null;
  let selectedQuality = 'FLAC';
  let polling = null;
  let latestSearchResults = [];
  let selectedSearchFilter = 'all';

  const STATE_KEY = 'deemix_state';
  function saveSearchState(patch) {
    YTPersist.save(STATE_KEY, patch);
  }

  const DOWNLOAD_KEY = 'deemix_download';
  let activeDownloadId = null;

  const previewAudio = new Audio();
  let previewButton = null;
  function togglePreview(url, button) {
    if (!url) return;
    if (previewButton === button && !previewAudio.paused) {
      previewAudio.pause();
      return;
    }
    if (previewButton && previewButton !== button) {
      previewButton.textContent = '▶';
      previewButton.classList.remove('playing');
    }
    previewAudio.src = url;
    previewAudio.currentTime = 0;
    previewAudio.play().catch(() => {});
    previewButton = button;
    button.textContent = '❚❚';
    button.classList.add('playing');
  }
  previewAudio.addEventListener('pause', () => {
    if (previewButton) {
      previewButton.textContent = '▶';
      previewButton.classList.remove('playing');
    }
  });
  previewAudio.addEventListener('ended', () => { previewButton = null; });

  analyseButton.addEventListener('click', analyseUrl);
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') analyseUrl();
  });
  searchButton.addEventListener('click', searchMusic);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchMusic();
  });

  document.querySelectorAll('#deemix-search-filters .fmt-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#deemix-search-filters .fmt-tab').forEach((tab) => {
        tab.classList.remove('active');
        tab.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      selectedSearchFilter = button.dataset.filter;
      renderSearchResults(latestSearchResults);
      if (latestSearchResults.length) saveSearchState({ query: searchInput.value.trim(), results: latestSearchResults, filter: selectedSearchFilter });
    });
  });

  document.querySelectorAll('#deemix-quality-tabs .q-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#deemix-quality-tabs .q-btn').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');
      selectedQuality = button.dataset.quality;
    });
  });

  document.getElementById('deemix-check-all').addEventListener('click', () => {
    tracks.querySelectorAll('.track-check').forEach((box) => { box.checked = true; });
    updateSelection();
  });
  document.getElementById('deemix-uncheck-none').addEventListener('click', () => {
    tracks.querySelectorAll('.track-check').forEach((box) => { box.checked = false; });
    updateSelection();
  });

  downloadButton.addEventListener('click', startDownload);

  coverBtn.addEventListener('click', async () => {
    if (!deemixData || !deemixData.thumbnail) return;
    coverBtn.disabled = true;
    try {
      await window.DLQueue.downloadViaApi('/api/cover', { url: deemixData.thumbnail, title: deemixData.title }, 'cover.jpg');
    } catch (e) {
      showError(e.message || 'Pochette introuvable');
    } finally {
      coverBtn.disabled = false;
    }
  });

  async function analyseUrl(fromSearch) {
    const url = urlInput.value.trim();
    if (!url) return;

    hide(errorBox);
    hide(card);
    hide(progressCard);
    hide(doneCard);
    setLoading(true);

    try {
      const response = await fetch(`/api/deemix/info?url=${encodeURIComponent(url)}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Impossible d’analyser ce lien.');
      deemixData = data;
      renderMusic(data);
      show(card);
      // Un lien collé + Analyser est une intention explicite de télécharger ce
      // titre précis ; un clic sur un résultat de recherche est exploratoire
      // (on veut d'abord voir les pistes/réglages) — l'auto-download ne se
      // déclenche donc que dans le premier cas.
      if (!fromSearch && autoDlChk.checked) downloadButton.click();
    } catch (error) {
      showError(error.message || 'Serveur inaccessible.');
    } finally {
      setLoading(false);
    }
  }

  function renderMusic(data) {
    document.getElementById('deemix-cover').src = data.thumbnail || '';
    document.getElementById('deemix-title').textContent = data.title || '';
    document.getElementById('deemix-artist').textContent = data.artist || '';
    const single = data.kind === 'track' || data.total_tracks === 1;
    document.getElementById('deemix-track-count').textContent = data.total_tracks || 0;
    const kindLabels = { track: 'TITRE', playlist: 'PLAYLIST', album: 'ALBUM', artist: 'ARTISTE' };
    document.getElementById('deemix-kind').textContent = single ? 'TITRE' : (kindLabels[data.kind] || 'ALBUM');

    const list = data.tracks || [];
    tracks.replaceChildren();
    list.forEach((track, index) => {
      const position = track.track_number || index + 1;
      const row = document.createElement('label');
      row.className = 'track-row';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'track-check';
      box.checked = true;
      box.dataset.index = position;

      const knob = document.createElement('span');
      knob.className = 'switch';

      const num = document.createElement('span');
      num.className = 'track-num';
      num.textContent = position;

      const text = document.createElement('span');
      text.className = 'track-text';
      text.append(Object.assign(document.createElement('strong'), { textContent: track.title || '' }));
      if (track.artist) text.append(Object.assign(document.createElement('span'), { textContent: ` — ${track.artist}` }));

      row.append(box, knob, num, text);

      if (track.preview) {
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'preview-btn';
        previewBtn.textContent = '▶';
        previewBtn.setAttribute('aria-label', 'Écouter un extrait');
        previewBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          togglePreview(track.preview, previewBtn);
        });
        row.appendChild(previewBtn);
      }

      tracks.appendChild(row);
    });

    if (list.length > 1) {
      tracks.querySelectorAll('.track-check').forEach((box) => {
        box.addEventListener('change', updateSelection);
      });
    }
    updateSelection();
  }

  function selectedIndices() {
    return Array.from(tracks.querySelectorAll('.track-check'))
      .filter((box) => box.checked)
      .map((box) => Number(box.dataset.index));
  }

  function updateSelection() {
    const boxes = Array.from(tracks.querySelectorAll('.track-check'));
    const total = boxes.length;
    const count = boxes.filter((box) => box.checked).length;
    document.getElementById('deemix-selected-count').textContent = count;
    if (total > 1) {
      downloadButton.textContent = count === 0
        ? 'Aucune piste sélectionnée'
        : (count === total ? `Télécharger (${total} pistes)` : `Télécharger la sélection (${count}/${total})`);
    } else {
      downloadButton.textContent = 'Télécharger le morceau';
    }
    downloadButton.disabled = count === 0;
  }

  async function searchMusic() {
    const query = searchInput.value.trim();
    if (!query) return;
    hide(errorBox);
    searchResults.replaceChildren();
    setSearchLoading(true);
    try {
      const response = await fetch(`/api/search?type=deemix&q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Recherche impossible.');
      latestSearchResults = data.results || [];
      renderSearchResults(latestSearchResults);
      saveSearchState({ query, results: latestSearchResults, filter: selectedSearchFilter });
    } catch (error) {
      showError(error.message || 'Serveur inaccessible.');
    } finally {
      setSearchLoading(false);
    }
  }

  function renderSearchResults(results) {
    searchResults.replaceChildren();
    searchResults.className = 'results-grid';
    searchResults.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; margin-top:12px;';
    const filtered = selectedSearchFilter === 'all'
      ? results
      : results.filter((item) => item.type === selectedSearchFilter);
    const labels = { all: 'résultat', track: 'titre', album: 'album', artist: 'artiste', playlist: 'playlist' };
    searchSummary.textContent = `${filtered.length} ${labels[selectedSearchFilter]}${filtered.length === 1 ? '' : 's'}`;
    filtered.forEach((item) => {
      const result = document.createElement('article');
      result.className = 'card';
      result.tabIndex = 0;
      result.setAttribute('role', 'button');
      result.style.cssText = 'cursor:pointer; padding:12px;';
      const kind = { track: 'Titre', album: 'Album', artist: 'Artiste', playlist: 'Playlist' }[item.type] || 'Deezer';
      const cover = document.createElement('div');
      cover.className = 'thumb-wrap';
      cover.style.cssText = 'aspect-ratio:1/1; margin-bottom:8px;';
      const image = document.createElement('img');
      image.src = item.thumbnail || '';
      image.alt = item.title ? `Pochette : ${item.title}` : 'Pochette Deezer';
      cover.appendChild(image);
      const quickDlBtn = document.createElement('button');
      quickDlBtn.type = 'button';
      quickDlBtn.className = 'quick-dl-btn';
      quickDlBtn.title = 'Télécharger (FLAC)';
      quickDlBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';
      quickDlBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        quickDlBtn.disabled = true;
        window.DLQueue.quickDownloadDeemix(item.url, {
          title: item.title, subtitle: item.artist || '', thumbnail: item.thumbnail,
        }).finally(() => { quickDlBtn.disabled = false; });
      });
      cover.appendChild(quickDlBtn);
      const title = document.createElement('h3');
      title.textContent = item.title || 'Sans titre';
      const meta = document.createElement('p');
      meta.className = 'meta-sub';
      meta.textContent = `${kind}${item.artist ? ` · ${item.artist}` : ''}${item.album ? ` · ${item.album}` : ''}`;
      result.append(cover, title, meta);

      const selectResult = () => {
        urlInput.value = item.url || '';
        hide(searchResults);
        analyseUrl(true);
      };
      result.addEventListener('click', selectResult);
      result.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectResult();
        }
      });
      searchResults.appendChild(result);
    });
  }

  async function startDownload() {
    if (!deemixData) return;
    previewAudio.pause();
    downloadButton.disabled = true;
    hide(errorBox);
    hide(card);
    hide(doneCard);
    resetProgress();
    show(progressCard);

    const total = (deemixData.tracks || []).length;
    const selected = selectedIndices();
    const payloadTracks = total > 1 && selected.length < total ? selected : null;

    const queueEntry = window.DLQueue.add({
      service: 'deemix', autoSave: autoDlChk.checked,
      title: deemixData.title, subtitle: deemixData.artist || '', thumbnail: deemixData.thumbnail,
    });

    try {
      const response = await fetch('/api/deemix/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: deemixData.url,
          quality: selectedQuality,
          settings: collectSettings(),
          ...(payloadTracks ? { selected_tracks: payloadTracks } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Le téléchargement n’a pas pu démarrer.');
      activeDownloadId = data.download_id;
      window.DLQueue.attach(queueEntry, data.download_id);
      YTPersist.save(DOWNLOAD_KEY, { downloadId: data.download_id });
      pollProgress(data.download_id);
    } catch (error) {
      window.DLQueue.fail(queueEntry, error.message || 'Serveur inaccessible.');
      hide(progressCard);
      downloadButton.disabled = false;
      showError(error.message || 'Serveur inaccessible.');
    }
  }

  function pollProgress(downloadId) {
    clearInterval(polling);
    polling = setInterval(async () => {
      try {
        const response = await fetch(`/api/progress/${downloadId}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        updateProgress(data);
        if (data.status === 'done') {
          clearInterval(polling);
          downloadButton.disabled = false;
          hide(progressCard);
          activeDownloadId = null;
          document.getElementById('deemix-done-name').textContent = data.filename || '';
          document.getElementById('deemix-save-link').href = `/api/file/${downloadId}`;
          show(doneCard);
          YTPersist.clear(DOWNLOAD_KEY);
        } else if (data.status === 'error') {
          clearInterval(polling);
          downloadButton.disabled = false;
          hide(progressCard);
          activeDownloadId = null;
          showError(data.error || 'Erreur pendant le téléchargement.');
          YTPersist.clear(DOWNLOAD_KEY);
        } else if (data.status === 'cancelled') {
          clearInterval(polling);
          downloadButton.disabled = false;
          hide(progressCard);
          activeDownloadId = null;
          YTPersist.clear(DOWNLOAD_KEY);
        }
      } catch (error) {
        clearInterval(polling);
        downloadButton.disabled = false;
        hide(progressCard);
        activeDownloadId = null;
        showError(error.message || 'Serveur inaccessible.');
        YTPersist.clear(DOWNLOAD_KEY);
      }
    }, 700);
  }

  progressCancelBtn.addEventListener('click', async () => {
    if (!activeDownloadId) return;
    progressCancelBtn.disabled = true;
    await window.DLQueue.cancelById(activeDownloadId);
    clearInterval(polling);
    hide(progressCard);
    downloadButton.disabled = false;
    YTPersist.clear(DOWNLOAD_KEY);
    activeDownloadId = null;
    progressCancelBtn.disabled = false;
  });

  function updateProgress(data) {
    const progress = Math.min(100, Math.round(data.progress || 0));
    document.getElementById('deemix-progress-fill').style.width = `${progress}%`;
    document.getElementById('deemix-progress-pct').textContent = `${progress}%`;
    document.getElementById('deemix-progress-label').textContent = data.current_title || 'Téléchargement...';
    document.getElementById('deemix-progress-current').textContent = data.total > 1 ? `Fichier ${data.current} / ${data.total}` : '';
  }

  function resetProgress() {
    document.getElementById('deemix-progress-fill').style.width = '0%';
    document.getElementById('deemix-progress-pct').textContent = '0%';
    document.getElementById('deemix-progress-label').textContent = 'Démarrage...';
    document.getElementById('deemix-progress-current').textContent = '';
  }

  function collectSettings() {
    const checked = (id) => document.getElementById(id).checked;
    return {
      embed_lyrics: checked('deemix-setting-embed-lyrics'),
      save_lrc: checked('deemix-setting-save-lrc'),
      artist_folders: checked('deemix-setting-artist-folders'),
      album_folders: checked('deemix-setting-album-folders'),
      playlist_folders: checked('deemix-setting-playlist-folders'),
      keep_featuring: checked('deemix-setting-featuring'),
      allow_fallback: checked('deemix-setting-fallback'),
      concurrency: Number(document.getElementById('deemix-setting-concurrency').value),
    };
  }

  function setLoading(isLoading) {
    analyseButton.disabled = isLoading;
    analyseLabel.classList.toggle('hidden', isLoading);
    analyseSpinner.classList.toggle('hidden', !isLoading);
  }

  function setSearchLoading(isLoading) {
    searchButton.disabled = isLoading;
    searchLabel.classList.toggle('hidden', isLoading);
    searchSpinner.classList.toggle('hidden', !isLoading);
  }

  function showError(message) {
    errorBox.textContent = message;
    show(errorBox);
  }

  function show(element) { element.classList.remove('hidden'); }
  function hide(element) { element.classList.add('hidden'); }

  // ── Bouton retour : visible dès qu'une carte résultat/progression/terminé
  // est affichée, ramène à l'état de recherche initial sans recharger la
  // page. Le téléchargement en cours continue côté serveur (resumable via
  // YTPersist au prochain chargement) — "retour" arrête juste le suivi UI.
  [card, progressCard, doneCard].forEach((el) => {
    const observer = new MutationObserver(() => {
      const anyVisible = [card, progressCard, doneCard].some((c) => !c.classList.contains('hidden'));
      backBtn.classList.toggle('hidden', !anyVisible);
    });
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  backBtn.addEventListener('click', () => {
    clearInterval(polling);
    hide(card);
    hide(progressCard);
    hide(doneCard);
    hide(errorBox);
    urlInput.value = '';
    urlInput.focus();
    if (latestSearchResults.length) show(searchResults);
  });

  // ── Recherche restaurée uniquement lors d'un retour arrière du navigateur
  // (pas sur un simple rechargement ni une arrivée directe sur la page) ──
  function restoreSearchState() {
    if (!YTPersist.isBackForward()) return;
    const state = YTPersist.load(STATE_KEY);
    if (!state || !state.results) return;

    searchInput.value = state.query || '';
    latestSearchResults = state.results;
    selectedSearchFilter = state.filter || 'all';
    document.querySelectorAll('#deemix-search-filters .fmt-tab').forEach((tab) => {
      const active = tab.dataset.filter === selectedSearchFilter;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    renderSearchResults(latestSearchResults);
  }

  restoreSearchState();

  // ── Le téléchargement continue côté serveur même après un F5 : on retrouve
  // sa progression s'il tourne encore, sans rien afficher s'il est déjà fini
  // ou en erreur (pour ne pas faire réapparaître un vieux résultat) ──
  async function resumeActiveDownload() {
    const state = YTPersist.load(DOWNLOAD_KEY);
    if (!state || !state.downloadId) return;
    try {
      const response = await fetch(`/api/progress/${state.downloadId}`);
      const data = await response.json();
      if (data.error || data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
        YTPersist.clear(DOWNLOAD_KEY);
        return;
      }
      hide(card);
      resetProgress();
      updateProgress(data);
      show(progressCard);
      downloadButton.disabled = true;
      activeDownloadId = state.downloadId;
      pollProgress(state.downloadId);
    } catch {
      /* pas grave : au pire on rate la reprise, le téléchargement continue quand même côté serveur */
    }
  }
  resumeActiveDownload();

  // ── Indicateur de version du paquet deemix (auto-mis à jour côté serveur) ──
  async function loadVersionBadge() {
    const badge = document.getElementById('deemix-version-badge');
    if (!badge) return;
    try {
      const res = await fetch('/api/version');
      const data = await res.json();
      const info = (data.packages || {}).deemix || {};
      const dot = badge.querySelector('.version-dot');
      const text = document.getElementById('deemix-v-text');
      dot.classList.remove('ok', 'checking', 'error');
      dot.classList.add(['ok', 'checking', 'error'].includes(info.status) ? info.status : 'ok');
      text.textContent = info.version ? `deemix ${info.version}` : 'deemix';
      badge.title = info.last_check ? `Dernière vérification : ${new Date(info.last_check).toLocaleString('fr-FR')}` : 'Vérification à venir';
      badge.classList.remove('hidden');
    } catch {
      /* silencieux */
    }
  }
  loadVersionBadge();
});

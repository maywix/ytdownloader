document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('deemix-url');
  const analyseButton = document.getElementById('deemix-analyse-btn');
  const analyseLabel = document.getElementById('deemix-analyse-label');
  const analyseSpinner = document.getElementById('deemix-analyse-spinner');
  const errorBox = document.getElementById('deemix-error');
  const card = document.getElementById('deemix-card');
  const progressCard = document.getElementById('deemix-progress');
  const doneCard = document.getElementById('deemix-done');
  const downloadButton = document.getElementById('deemix-download-btn');
  const tracks = document.getElementById('deemix-tracks');
  const searchInput = document.getElementById('deemix-search');
  const searchButton = document.getElementById('deemix-search-btn');
  const searchLabel = document.getElementById('deemix-search-label');
  const searchSpinner = document.getElementById('deemix-search-spinner');
  const searchResults = document.getElementById('deemix-results');
  const searchSummary = document.getElementById('deemix-search-summary');

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

  downloadButton.addEventListener('click', startDownload);

  async function analyseUrl() {
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
      const row = document.createElement('div');
      row.className = 'track-row';
      row.style.cursor = 'default';

      const num = document.createElement('span');
      num.className = 'track-num';
      num.textContent = position;

      const text = document.createElement('span');
      text.className = 'track-text';
      text.append(Object.assign(document.createElement('strong'), { textContent: track.title || '' }));
      if (track.artist) text.append(Object.assign(document.createElement('span'), { textContent: ` — ${track.artist}` }));

      row.append(num, text);

      if (track.preview) {
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'preview-btn';
        previewBtn.textContent = '▶';
        previewBtn.setAttribute('aria-label', 'Écouter un extrait');
        previewBtn.addEventListener('click', () => togglePreview(track.preview, previewBtn));
        row.appendChild(previewBtn);
      }

      tracks.appendChild(row);
    });

    downloadButton.textContent = single ? 'Télécharger le morceau' : `Télécharger (${list.length} pistes)`;
    downloadButton.disabled = list.length === 0;
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
      const title = document.createElement('h3');
      title.textContent = item.title || 'Sans titre';
      const meta = document.createElement('p');
      meta.className = 'meta-sub';
      meta.textContent = `${kind}${item.artist ? ` · ${item.artist}` : ''}${item.album ? ` · ${item.album}` : ''}`;
      result.append(cover, title, meta);

      const selectResult = () => {
        urlInput.value = item.url || '';
        hide(searchResults);
        analyseUrl();
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
    downloadButton.disabled = true;
    hide(errorBox);
    hide(card);
    hide(doneCard);
    resetProgress();
    show(progressCard);

    try {
      const response = await fetch('/api/deemix/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: deemixData.url,
          quality: selectedQuality,
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Le téléchargement n’a pas pu démarrer.');
      YTPersist.save(DOWNLOAD_KEY, { downloadId: data.download_id });
      pollProgress(data.download_id);
    } catch (error) {
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
          document.getElementById('deemix-done-name').textContent = data.filename || '';
          document.getElementById('deemix-save-link').href = `/api/file/${downloadId}`;
          show(doneCard);
          YTPersist.clear(DOWNLOAD_KEY);
        } else if (data.status === 'error') {
          clearInterval(polling);
          downloadButton.disabled = false;
          hide(progressCard);
          showError(data.error || 'Erreur pendant le téléchargement.');
          YTPersist.clear(DOWNLOAD_KEY);
        }
      } catch (error) {
        clearInterval(polling);
        downloadButton.disabled = false;
        hide(progressCard);
        showError(error.message || 'Serveur inaccessible.');
        YTPersist.clear(DOWNLOAD_KEY);
      }
    }, 700);
  }

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
      if (data.error || data.status === 'done' || data.status === 'error') {
        YTPersist.clear(DOWNLOAD_KEY);
        return;
      }
      hide(card);
      resetProgress();
      updateProgress(data);
      show(progressCard);
      downloadButton.disabled = true;
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

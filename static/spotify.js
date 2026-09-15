document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('spotify-url');
  const analyseButton = document.getElementById('spotify-analyse-btn');
  const analyseLabel = document.getElementById('spotify-analyse-label');
  const analyseSpinner = document.getElementById('spotify-analyse-spinner');
  const errorBox = document.getElementById('spotify-error');
  const card = document.getElementById('spotify-card');
  const progressCard = document.getElementById('spotify-progress');
  const doneCard = document.getElementById('spotify-done');
  const downloadButton = document.getElementById('spotify-download-btn');
  const tracks = document.getElementById('spotify-tracks');
  const searchInput = document.getElementById('spotify-search');
  const searchButton = document.getElementById('spotify-search-btn');
  const searchLabel = document.getElementById('spotify-search-label');
  const searchSpinner = document.getElementById('spotify-search-spinner');
  const searchResults = document.getElementById('spotify-results');
  const searchSummary = document.getElementById('spotify-search-summary');

  let spotifyData = null;
  let selectedFormat = 'flac';
  let selectedQuality = 'LOSSLESS';
  let selectedBitrate = '320k';
  let selectedSources = Array.from(document.querySelectorAll('#spotify-source-tabs .fmt-tab')).map((tab) => tab.dataset.source);
  let polling = null;
  let latestSearchResults = [];
  let selectedSearchFilter = 'all';

  const STATE_KEY = 'spotiflac_state';
  function saveState(patch) {
    YTPersist.save(STATE_KEY, { ...(YTPersist.load(STATE_KEY) || {}), ...patch });
  }

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

  document.querySelectorAll('#spotify-format-tabs .fmt-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#spotify-format-tabs .fmt-tab').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');
      selectedFormat = button.dataset.format;
      document.getElementById('spotify-mp3-bitrate').classList.toggle('hidden', selectedFormat !== 'mp3');
    });
  });

  document.querySelectorAll('#spotify-quality-tabs .q-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#spotify-quality-tabs .q-btn').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');
      selectedQuality = button.dataset.quality;
    });
  });

  const settingsToggle = document.getElementById('spotify-settings-toggle');
  const settingsPanel = document.getElementById('spotify-settings-panel');
  settingsToggle.addEventListener('click', () => {
    const willOpen = settingsPanel.classList.contains('hidden');
    settingsPanel.classList.toggle('hidden', !willOpen);
    settingsToggle.setAttribute('aria-expanded', String(willOpen));
  });

  document.querySelectorAll('#spotify-source-tabs .fmt-tab').forEach((button) => {
    button.addEventListener('click', () => {
      const active = document.querySelectorAll('#spotify-source-tabs .fmt-tab.active');
      if (active.length === 1 && button.classList.contains('active')) return;
      button.classList.toggle('active');
      button.setAttribute('aria-pressed', String(button.classList.contains('active')));
      selectedSources = Array.from(document.querySelectorAll('#spotify-source-tabs .fmt-tab.active')).map((tab) => tab.dataset.source);
    });
  });

  document.querySelectorAll('#spotify-bitrate-tabs .q-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#spotify-bitrate-tabs .q-btn').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');
      selectedBitrate = button.dataset.bitrate;
    });
  });

  document.querySelectorAll('#spotify-search-filters .fmt-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#spotify-search-filters .fmt-tab').forEach((tab) => {
        tab.classList.remove('active');
        tab.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      selectedSearchFilter = button.dataset.filter;
      renderSearchResults(latestSearchResults);
    });
  });

  downloadButton.addEventListener('click', startDownload);

  document.getElementById('spotify-check-all').addEventListener('click', () => {
    tracks.querySelectorAll('.track-check').forEach((box) => { box.checked = true; });
    updateSelection();
  });
  document.getElementById('spotify-uncheck-none').addEventListener('click', () => {
    tracks.querySelectorAll('.track-check').forEach((box) => { box.checked = false; });
    updateSelection();
  });

  async function analyseUrl() {
    const url = urlInput.value.trim();
    if (!url) return;

    hide(errorBox);
    hide(card);
    hide(progressCard);
    hide(doneCard);
    setLoading(true);

    try {
      const response = await fetch(`/api/music_info?url=${encodeURIComponent(url)}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Impossible d’analyser ce lien Spotify.');
      spotifyData = data;
      renderMusic(data);
      show(card);
      saveState({ lastUrl: url, lastData: data, downloadId: null });
    } catch (error) {
      showError(error.message || 'Serveur inaccessible.');
    } finally {
      setLoading(false);
    }
  }

  function renderMusic(data) {
    document.getElementById('spotify-cover').src = data.thumbnail || '';
    document.getElementById('spotify-title').textContent = data.title || '';
    document.getElementById('spotify-artist').textContent = data.artist || '';
    const single = data.kind === 'track' || data.total_tracks === 1;
    document.getElementById('spotify-track-count').textContent = data.total_tracks || 0;
    const kindLabels = { track: 'TITRE', playlist: 'PLAYLIST', album: 'ALBUM', artist: 'ARTISTE' };
    document.getElementById('spotify-kind').textContent = single ? 'TITRE' : (kindLabels[data.kind] || 'ALBUM');

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
      if (track.album && data.kind === 'artist') text.append(Object.assign(document.createElement('em'), { textContent: ` · ${track.album}` }));

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
    document.getElementById('spotify-selected-count').textContent = count;
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
      const response = await fetch(`/api/search?type=spotify&q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Recherche impossible.');
      latestSearchResults = data.results || [];
      renderSearchResults(latestSearchResults);
    } catch (error) {
      showError(error.message || 'Serveur inaccessible.');
    } finally {
      setSearchLoading(false);
    }
  }

  function renderSearchResults(results) {
    searchResults.replaceChildren();
    searchResults.className = 'results-grid';
    // Reuse the card presentation already used by the YTDown search page,
    // without altering the shared stylesheet.
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
      const kind = { track: 'Titre', album: 'Album', artist: 'Artiste', playlist: 'Playlist' }[item.type] || 'Spotify';
      const cover = document.createElement('div');
      cover.className = 'thumb-wrap';
      cover.style.cssText = 'aspect-ratio:1/1; margin-bottom:8px;';
      const image = document.createElement('img');
      image.src = item.thumbnail || '';
      image.alt = item.title ? `Pochette : ${item.title}` : 'Pochette Spotify';
      cover.appendChild(image);
      const title = document.createElement('h3');
      title.textContent = item.title || 'Sans titre';
      const meta = document.createElement('p');
      meta.className = 'meta-sub';
      meta.textContent = `${kind}${item.artist ? ` · ${item.artist}` : ''}${item.album ? ` · ${item.album}` : ''}`;
      result.append(cover, title, meta);

      const selectResult = () => {
        // L'URL vient du client de métadonnées SpotiFLAC. Pour un artiste,
        // le backend résout toute la discographie ; pour le reste, on analyse
        // d'abord le lien pour garder les vraies pistes album/playlist.
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
    if (!spotifyData) return;
    downloadButton.disabled = true;
    hide(errorBox);
    hide(card);
    hide(doneCard);
    resetProgress();
    show(progressCard);

    const total = (spotifyData.tracks || []).length;
    const selected = selectedIndices();
    const payloadTracks = total > 1 && selected.length < total ? selected : null;

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spoti_data: {
            ...spotifyData,
            settings: collectSettings(),
            ...(payloadTracks ? { selected_tracks: payloadTracks } : {}),
          },
          format: selectedFormat,
          quality: selectedQuality,
          mode: 'spoti_album',
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Le téléchargement n’a pas pu démarrer.');
      saveState({ downloadId: data.download_id });
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
          document.getElementById('spotify-done-name').textContent = data.filename || '';
          document.getElementById('spotify-save-link').href = `/api/file/${downloadId}`;
          show(doneCard);
        } else if (data.status === 'error') {
          clearInterval(polling);
          downloadButton.disabled = false;
          hide(progressCard);
          showError(data.error || 'Erreur pendant le téléchargement.');
          saveState({ downloadId: null });
        }
      } catch (error) {
        clearInterval(polling);
        downloadButton.disabled = false;
        hide(progressCard);
        showError(error.message || 'Serveur inaccessible.');
      }
    }, 700);
  }

  function updateProgress(data) {
    const progress = Math.min(100, Math.round(data.progress || 0));
    document.getElementById('spotify-progress-fill').style.width = `${progress}%`;
    document.getElementById('spotify-progress-pct').textContent = `${progress}%`;
    document.getElementById('spotify-progress-label').textContent = data.current_title || 'Téléchargement...';
    document.getElementById('spotify-progress-current').textContent = data.total > 1 ? `Fichier ${data.current} / ${data.total}` : '';
    document.getElementById('spotify-progress-speed').textContent = data.speed || '';
    document.getElementById('spotify-progress-eta').textContent = data.eta ? `ETA ${data.eta}` : '';
  }

  function resetProgress() {
    document.getElementById('spotify-progress-fill').style.width = '0%';
    document.getElementById('spotify-progress-pct').textContent = '0%';
    document.getElementById('spotify-progress-label').textContent = 'Démarrage...';
    document.getElementById('spotify-progress-current').textContent = '';
    document.getElementById('spotify-progress-speed').textContent = '';
    document.getElementById('spotify-progress-eta').textContent = '';
  }

  function collectSettings() {
    const checked = (id) => document.getElementById(id).checked;
    return {
      services: selectedSources,
      source_quality: selectedQuality,
      transcode_to: selectedFormat,
      transcode_bitrate: selectedBitrate,
      embed_lyrics: checked('setting-embed-lyrics'),
      save_lrc: checked('setting-save-lrc'),
      apple_lyrics_word_by_word: checked('setting-word-lyrics'),
      save_canvas: checked('setting-canvas'),
      enrich_metadata: checked('setting-metadata'),
      use_track_numbers: checked('setting-track-numbers'),
      use_album_track_numbers: checked('setting-track-numbers'),
      use_artist_subfolders: checked('setting-artist-folders'),
      use_album_subfolders: checked('setting-album-folders'),
      create_playlist_subfolders: checked('setting-playlist-folders'),
      first_artist_only: checked('setting-first-artist'),
      include_featuring: checked('setting-featuring'),
      allow_fallback: checked('setting-fallback'),
      transcode_keep_original: checked('setting-keep-original'),
      verify_hires: checked('setting-verify-hires'),
      max_concurrent_downloads: Number(document.getElementById('setting-concurrency').value),
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

  // ── Reprise après rechargement / fermeture de fenêtre, ou lien venu d'ailleurs ──
  async function restoreState() {
    const paramUrl = new URLSearchParams(window.location.search).get('url');
    if (paramUrl) {
      urlInput.value = paramUrl;
      analyseUrl();
      return;
    }

    const state = YTPersist.load(STATE_KEY);
    if (!state) return;

    if (state.downloadId) {
      hide(card);
      resetProgress();
      show(progressCard);
      try {
        const response = await fetch(`/api/progress/${state.downloadId}`);
        const data = await response.json();
        if (data.error) {
          hide(progressCard);
          saveState({ downloadId: null });
          restoreLastView(state);
          return;
        }
        updateProgress(data);
        if (data.status === 'done') {
          hide(progressCard);
          document.getElementById('spotify-done-name').textContent = data.filename || '';
          document.getElementById('spotify-save-link').href = `/api/file/${state.downloadId}`;
          show(doneCard);
        } else if (data.status === 'error') {
          hide(progressCard);
          showError(data.error || 'Erreur pendant le téléchargement.');
          saveState({ downloadId: null });
        } else {
          pollProgress(state.downloadId);
        }
      } catch {
        hide(progressCard);
      }
      return;
    }

    restoreLastView(state);
  }

  function restoreLastView(state) {
    if (!state.lastData) return;
    urlInput.value = state.lastUrl || '';
    spotifyData = state.lastData;
    renderMusic(state.lastData);
    show(card);
  }

  restoreState();
});

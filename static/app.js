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
  const spotiCard = document.getElementById('spoti-card');
  const progressCard = document.getElementById('progress-card');
  const doneCard = document.getElementById('done-card');
  const errorMsg = document.getElementById('error-msg');

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

  // SpotiFLAC Card Elements
  const spotiCover = document.getElementById('spoti-cover');
  const spotiBadge = document.getElementById('spoti-badge');
  const spotiTitle = document.getElementById('spoti-title');
  const spotiArtist = document.getElementById('spoti-artist');
  const spotiCount = document.getElementById('spoti-count');
  const spotiTrackList = document.getElementById('spoti-track-list');
  const spotiDlBtn = document.getElementById('spoti-dl-btn');

  let currentUrl = '';
  let curFmt = 'mp4';
  let curQ = '1080';
  let pCurFmt = 'mp4';
  let spotiFmt = 'flac';
  let currentSpotiData = null;

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

      if (data.type === 'spotify' && data.spotify_data) {
        renderSpotiCard(data.spotify_data);
      } else if (data.type === 'playlist') {
        renderPlaylistCard(data);
      } else {
        renderVideoCard(data);
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
    show(videoCard);
  }

  function renderPlaylistCard(data) {
    pThumb.src = data.thumbnail || '';
    pTitle.textContent = data.title || '';
    pChannel.textContent = data.channel || '';
    pCount.textContent = `${data.count} éléments`;
    show(playlistCard);
  }

  function renderSpotiCard(data) {
    currentSpotiData = data;
    spotiCover.src = data.thumbnail || '';
    spotiTitle.textContent = data.title || '';
    spotiArtist.textContent = data.artist ? `Par ${data.artist}` : '';
    spotiCount.textContent = data.total_tracks || 1;

    const isSingle = data.kind === 'track' || data.total_tracks === 1;
    spotiBadge.textContent = isSingle ? 'TITRE' : (data.kind === 'playlist' ? 'PLAYLIST' : 'ALBUM');
    spotiDlBtn.textContent = isSingle ? 'Télécharger le morceau' : `Télécharger l'Album complet (${data.total_tracks} pistes) (.zip)`;

    spotiTrackList.innerHTML = '';
    (data.tracks || []).forEach((t, i) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);';
      div.innerHTML = `<span>${t.track_number || i+1}. ${t.title}</span><span style="color:var(--muted);">${t.artist || ''}</span>`;
      spotiTrackList.appendChild(div);
    });

    show(spotiCard);
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

  document.querySelectorAll('#spoti-fmt-tabs .fmt-tab').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#spoti-fmt-tabs .fmt-tab').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      spotiFmt = chip.dataset.spotiFmt;
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
    } catch {
      musicError.textContent = 'Serveur inaccessible';
      show(musicError);
    } finally {
      setMusicLoading(false);
    }
  }

  function renderGrid(container, results) {
    container.innerHTML = '';
    (results || []).forEach(item => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'padding: 12px; cursor: pointer; transition: border-color 0.15s;';
      card.innerHTML = `
        <div class="thumb-wrap" style="aspect-ratio: 16/9; margin-bottom: 8px;">
          <img src="${item.thumbnail || ''}" style="width:100%; height:100%; object-fit:cover;">
        </div>
        <h4 style="font-size: 13px; font-weight: 600; line-height: 1.3; height: 2.6em; overflow: hidden; margin-bottom: 4px;">${item.title}</h4>
        <p style="font-size: 11px; color: var(--muted);">${item.artist || item.channel || ''}</p>
      `;
      card.addEventListener('click', () => {
        if (item.query) {
          const spotiData = {
            title: item.title,
            artist: item.artist,
            thumbnail: item.thumbnail,
            kind: 'track',
            total_tracks: 1,
            tracks: [{
              title: item.title,
              artist: item.artist,
              track_number: 1,
              duration: item.duration,
              query: item.query
            }]
          };
          renderSpotiCard(spotiData);
        } else {
          urlInput.value = item.url;
          document.getElementById('tab-url-btn').click();
          runFetch();
        }
      });
      container.appendChild(card);
    });
  }

  // ── Downloads & Polling ──
  dlBtn.addEventListener('click', () => startDownload('single', curFmt, curQ));
  pDlBtn.addEventListener('click', () => startDownload('playlist', pCurFmt, '1080'));

  spotiDlBtn.addEventListener('click', () => {
    if (!currentSpotiData) return;
    startSpotiDownload(currentSpotiData, spotiFmt);
  });

  async function startSpotiDownload(spotiData, fmt) {
    spotiDlBtn.disabled = true;
    hideAllCards();
    resetProgress();
    show(progressCard);

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoti_data: spotiData, format: fmt, mode: 'spoti_album' }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        showError(data.error || 'Erreur lors du démarrage');
        hide(progressCard);
        spotiDlBtn.disabled = false;
        return;
      }
      pollProgress(data.download_id, spotiDlBtn);
    } catch {
      showError('Serveur inaccessible');
      hide(progressCard);
      spotiDlBtn.disabled = false;
    }
  }

  async function startDownload(mode, fmt, quality) {
    const btn = mode === 'playlist' ? pDlBtn : dlBtn;
    btn.disabled = true;
    hideAllCards();
    resetProgress();
    show(progressCard);

    try {
      const res = await fetch('/api/download', {
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
      pollProgress(data.download_id, btn);
    } catch {
      showError('Serveur inaccessible');
      hide(progressCard);
      btn.disabled = false;
    }
  }

  let pollTimer = null;

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
          return;
        }

        updateProgressUI(data);

        if (data.status === 'done') {
          stopPoll();
          if (btn) btn.disabled = false;
          showDone(id, data.filename, data.is_playlist);
        } else if (data.status === 'error') {
          stopPoll();
          if (btn) btn.disabled = false;
          hide(progressCard);
          showError(data.error || 'Erreur lors du traitement');
        }
      } catch { /* retry */ }
    }, 600);
  }

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
    saveLink.href = `/api/file/${id}`;
    saveLink.textContent = isPlaylist ? 'Télécharger (.zip)' : 'Sauvegarder';
    show(doneCard);
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
  function hideAllCards() { [videoCard, playlistCard, spotiCard, progressCard, doneCard, errorMsg, urlSearchResults].forEach(hide); }

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

});

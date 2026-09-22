// ── Gestionnaire de téléchargements global ──────────────────────────────
// Partagé entre YTDown / SpotiFLAC / Deemix (même origine → même
// localStorage). Une icône dans le header ouvre un panneau déroulant qui
// liste tous les téléchargements en cours/terminés, peu importe la page où
// ils ont été lancés — /api/progress et /api/file sont déjà communs aux 3
// apps côté backend (même dict `downloads` en mémoire).
//
// Expose window.DLQueue :
//   .add({service, title, subtitle, thumbnail})        → entry (status 'pending')
//   .attach(entry, downloadId)                          → passe en 'downloading', lance le polling
//   .fail(entry, message)
//   .quickDownloadYoutube(url, meta)                    → YTDown (vidéo/playlist YouTube, TikTok...)
//   .quickDownloadSpotify(url, meta)                     → SpotiFLAC (résout puis télécharge, tout sélectionné)
//   .quickDownloadDeemix(url, meta)                      → Deemix (Deezer direct)
(function () {
  const STORAGE_KEY = 'ytdown_queue_v1';
  const MAX_ITEMS = 30;
  const POLL_MS = 1200;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_ITEMS))); } catch { /* quota/private mode */ }
  }

  let items = load();
  const timers = {};

  function uid() { return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function activeCount() {
    return items.filter((e) => e.status === 'pending' || e.status === 'downloading').length;
  }

  function add({ service, title, subtitle, thumbnail, autoSave }) {
    const entry = {
      id: uid(), downloadId: null, service,
      title: title || 'Sans titre', subtitle: subtitle || '', thumbnail: thumbnail || '',
      status: 'pending', progress: 0, currentTitle: '', filename: '', error: null,
      autoSave: !!autoSave, saved: false,
      addedAt: Date.now(),
    };
    items.push(entry);
    persist();
    render();
    return entry;
  }

  // Déclenche le téléchargement réel du fichier vers l'appareil (l'équivalent
  // du clic sur "Sauver"). /api/file/<id> supprime l'entrée côté serveur une
  // fois servie (fichier + état) : un seul appel possible par téléchargement.
  function triggerSave(entry) {
    if (!entry.downloadId || entry.saved) return;
    if (entry.isPlaylist) {
      // Le zip est assemblé côté serveur avant le premier octet de réponse :
      // on passe par fetch()+blob pour pouvoir afficher "Préparation..."
      // pendant cette attente (une simple navigation <a href> resterait
      // muette). Fichier unique déjà sur disque : navigation native
      // (streaming direct, pas de blob géant à garder en mémoire).
      saveViaBlob(entry);
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/file/${entry.downloadId}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    entry.saved = true;
    persist();
    render();
  }

  async function saveViaBlob(entry) {
    if (!entry.downloadId || entry.saved || entry.preparing) return;
    entry.preparing = true;
    render();
    try {
      const res = await fetch(`/api/file/${entry.downloadId}`);
      if (!res.ok) throw new Error('Échec de la récupération du fichier');
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const filename = m ? m[1] : (entry.filename || entry.title || 'download.zip');
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      entry.saved = true;
    } catch (e) {
      entry.saveError = e.message || 'Erreur lors de la préparation du fichier';
    } finally {
      entry.preparing = false;
      persist();
      render();
    }
  }

  // Téléchargement générique d'une image proxifiée par le serveur (miniature
  // YouTube via /api/thumbnail, pochette Spotify/Deezer via /api/cover) :
  // même geste "POST → blob → <a download>" partout, pour que le bouton
  // se comporte pareil sur les 3 pages.
  async function downloadViaApi(endpoint, payload, fallbackFilename) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = 'Téléchargement impossible';
      try { message = (await res.json()).error || message; } catch { /* réponse non-JSON */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    const filename = m ? m[1] : fallbackFilename;
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
  }

  function attach(entry, downloadId) {
    entry.downloadId = downloadId;
    entry.status = 'downloading';
    persist();
    render();
    poll(entry);
  }

  function fail(entry, message) {
    entry.status = 'error';
    entry.error = message || 'Erreur';
    persist();
    render();
  }

  // Annule un téléchargement en cours (ou pas encore démarré). Le serveur
  // fait de son mieux pour interrompre le travail déjà en vol (yt-dlp,
  // SpotiFLAC, Deemix) ; côté client on arrête simplement le polling et on
  // marque l'entrée comme annulée, qu'importe si le serveur a pu réagir à
  // temps ou pas.
  async function cancel(entry) {
    if (!entry || entry.cancelling) return;
    if (entry.status !== 'pending' && entry.status !== 'downloading') return;
    entry.cancelling = true;
    render();
    try {
      if (entry.downloadId) await fetch(`/api/cancel/${entry.downloadId}`, { method: 'POST' });
    } catch { /* on annule quand même côté client */ }
    stop(entry);
    entry.cancelling = false;
    entry.status = 'cancelled';
    persist();
    render();
  }

  // Variante pour les pages appelantes (app.js/spotify.js/deemix.js) qui ne
  // gardent que l'id serveur, pas la référence à l'entrée de la file (par ex.
  // après un F5 : resumeActiveDownload() ne recrée pas l'entrée locale).
  function cancelById(downloadId) {
    const entry = items.find((e) => e.downloadId === downloadId);
    if (entry) return cancel(entry);
    return fetch(`/api/cancel/${downloadId}`, { method: 'POST' }).catch(() => {});
  }

  function poll(entry) {
    if (!entry.downloadId || timers[entry.downloadId]) return;
    timers[entry.downloadId] = setInterval(async () => {
      try {
        const res = await fetch(`/api/progress/${entry.downloadId}`);
        const data = await res.json();
        if (data.error && res.status === 404) {
          stop(entry); entry.status = 'error'; entry.error = data.error; persist(); render();
          return;
        }
        entry.progress = Math.min(100, Math.round(data.progress || 0));
        entry.currentTitle = data.current_title || '';
        if (data.status === 'done') {
          stop(entry);
          entry.status = 'done';
          entry.filename = data.filename || entry.title;
          entry.isPlaylist = !!data.is_playlist;
          entry.qualityMismatch = data.quality_mismatch || null;
          persist();
          render();
          // Une qualité inférieure à celle demandée (CD au lieu d'Atmos/Hi-Res)
          // est encore de la musique valide : on ne la jette plus (voir
          // app.py), mais l'auto-save ne doit pas la sauver sans prévenir —
          // ça reste à la personne de décider "quand même" ou "je réessaie".
          if (entry.autoSave && !entry.qualityMismatch) triggerSave(entry);
          return;
        } else if (data.status === 'error') {
          stop(entry);
          entry.status = 'error';
          entry.error = data.error || 'Erreur pendant le téléchargement';
        } else if (data.status === 'cancelled') {
          stop(entry);
          entry.status = 'cancelled';
        } else {
          entry.status = 'downloading';
        }
        persist();
        render();
      } catch { /* on retente au prochain tick */ }
    }, POLL_MS);
  }

  function stop(entry) {
    if (entry.downloadId && timers[entry.downloadId]) {
      clearInterval(timers[entry.downloadId]);
      delete timers[entry.downloadId];
    }
  }

  function resumeAll() {
    // Un F5 pendant un fetch() de zip laisserait "preparing" bloqué à true
    // pour toujours (rien ne le remet à false côté serveur, c'est un état
    // purement client) : on le réinitialise au chargement de la page.
    items.forEach((entry) => { if (entry.preparing) entry.preparing = false; if (entry.cancelling) entry.cancelling = false; });
    items.forEach((entry) => {
      if (entry.downloadId && (entry.status === 'downloading' || entry.status === 'pending')) poll(entry);
    });
  }

  function remove(id) {
    const entry = items.find((e) => e.id === id);
    if (entry) stop(entry);
    items = items.filter((e) => e.id !== id);
    persist();
    render();
  }

  function clearFinished() {
    items.filter((e) => e.status === 'done' || e.status === 'error' || e.status === 'cancelled').forEach(stop);
    items = items.filter((e) => e.status !== 'done' && e.status !== 'error' && e.status !== 'cancelled');
    persist();
    render();
  }

  // ── UI ──
  const SERVICE_LABEL = { ytdown: 'Eclypse', spotiflac: 'SpotiFLAC', deemix: 'Deemix' };
  let btnEl, badgeEl, panelEl, listEl;

  function svg(path, size) {
    return `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }
  const ICON_DL = svg('<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>');
  const ICON_CHECK = svg('<path d="M20 6L9 17l-5-5"/>', 13);
  const ICON_ERR = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', 13);
  const ICON_WARN = svg('<path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a1 1 0 0 0 .86 1.5h18.64a1 1 0 0 0 .86-1.5L13.71 3.86a1 1 0 0 0-1.72 0z"/>', 13);
  const ICON_CLOSE = svg('<path d="M18 6L6 18M6 6l12 12"/>', 12);

  function ensureUI() {
    const host = document.querySelector('.header-actions');
    if (!host || btnEl) return;

    const wrap = document.createElement('div');
    wrap.className = 'dlq-wrap';
    wrap.id = 'dlq-wrap';

    btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className = 'dlq-btn';
    btnEl.setAttribute('aria-haspopup', 'true');
    btnEl.setAttribute('aria-expanded', 'false');
    btnEl.title = 'Téléchargements';
    btnEl.innerHTML = ICON_DL + '<span class="dlq-badge hidden" id="dlq-badge">0</span>';

    panelEl = document.createElement('div');
    panelEl.className = 'dlq-panel hidden';
    panelEl.innerHTML = `
      <div class="dlq-panel-head">
        <span>Téléchargements</span>
        <button type="button" class="mini-btn" id="dlq-clear">Effacer terminés</button>
      </div>
      <div class="dlq-list" id="dlq-list"></div>
    `;

    wrap.append(btnEl, panelEl);
    host.insertBefore(wrap, host.firstChild);
    listEl = panelEl.querySelector('#dlq-list');
    badgeEl = btnEl.querySelector('#dlq-badge');

    btnEl.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = panelEl.classList.contains('hidden');
      panelEl.classList.toggle('hidden', !willOpen);
      btnEl.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (event) => {
      if (!wrap.contains(event.target)) {
        panelEl.classList.add('hidden');
        btnEl.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { panelEl.classList.add('hidden'); btnEl.setAttribute('aria-expanded', 'false'); }
    });
    panelEl.querySelector('#dlq-clear').addEventListener('click', clearFinished);
  }

  function statusLabel(entry) {
    if (entry.cancelling) return 'Annulation...';
    if (entry.status === 'pending') return 'Préparation...';
    if (entry.status === 'downloading') return entry.currentTitle || 'Téléchargement...';
    if (entry.status === 'done') return 'Terminé';
    if (entry.status === 'error') return entry.error || 'Erreur';
    if (entry.status === 'cancelled') return 'Annulé';
    return '';
  }

  function render() {
    if (badgeEl) {
      const n = activeCount();
      badgeEl.textContent = String(n);
      badgeEl.classList.toggle('hidden', n === 0);
    }
    if (!listEl) return;
    listEl.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'dlq-empty';
      empty.textContent = 'Aucun téléchargement pour l’instant.';
      listEl.appendChild(empty);
      return;
    }
    [...items].reverse().forEach((entry) => {
      const row = document.createElement('div');
      row.className = `dlq-item dlq-${entry.status}`;

      const thumb = document.createElement('div');
      thumb.className = 'dlq-thumb';
      if (entry.thumbnail) {
        const img = document.createElement('img');
        img.src = entry.thumbnail;
        img.alt = '';
        thumb.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'dlq-body';
      const title = document.createElement('p');
      title.className = 'dlq-title';
      title.textContent = entry.title;
      const meta = document.createElement('p');
      meta.className = 'dlq-meta';
      meta.textContent = `${SERVICE_LABEL[entry.service] || entry.service} · ${entry.subtitle || ''}`.replace(/ · $/, '');
      body.append(title, meta);

      if (entry.status === 'pending' || entry.status === 'downloading') {
        const track = document.createElement('div');
        track.className = 'dlq-track';
        const fill = document.createElement('div');
        fill.className = 'dlq-fill';
        fill.style.width = `${entry.progress || 0}%`;
        track.appendChild(fill);
        const label = document.createElement('p');
        label.className = 'dlq-status';
        label.textContent = statusLabel(entry);
        body.append(track, label);
      } else if (entry.status === 'done' && entry.preparing) {
        const label = document.createElement('p');
        label.className = 'dlq-status';
        label.innerHTML = '<span class="spinner spinner-sm"></span> Préparation du fichier...';
        body.appendChild(label);
      } else if (entry.status === 'done' && entry.saveError) {
        const label = document.createElement('p');
        label.className = 'dlq-status dlq-status-error';
        label.innerHTML = ICON_ERR + ' ' + entry.saveError;
        body.appendChild(label);
      } else if (entry.status === 'done' && entry.qualityMismatch) {
        const label = document.createElement('p');
        label.className = 'dlq-status dlq-status-warn';
        label.innerHTML = ICON_WARN + ' ' + entry.qualityMismatch;
        body.appendChild(label);
      } else if (entry.status === 'done') {
        const label = document.createElement('p');
        label.className = 'dlq-status dlq-status-done';
        label.innerHTML = ICON_CHECK + (entry.saved ? ' Enregistré' : ' Terminé');
        body.appendChild(label);
      } else if (entry.status === 'error') {
        const label = document.createElement('p');
        label.className = 'dlq-status dlq-status-error';
        label.innerHTML = ICON_ERR + ' ' + (entry.error || 'Erreur');
        body.appendChild(label);
      } else if (entry.status === 'cancelled') {
        const label = document.createElement('p');
        label.className = 'dlq-status';
        label.textContent = 'Annulé';
        body.appendChild(label);
      }

      const actions = document.createElement('div');
      actions.className = 'dlq-actions';
      if ((entry.status === 'pending' || entry.status === 'downloading') && !entry.cancelling) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'mini-btn mini-btn-danger';
        cancelBtn.textContent = 'Annuler';
        cancelBtn.addEventListener('click', () => cancel(entry));
        actions.appendChild(cancelBtn);
      }
      if (entry.status === 'done' && entry.downloadId && !entry.saved && !entry.preparing) {
        const label = entry.qualityMismatch ? 'Quand même' : (entry.isPlaylist ? '.zip' : 'Sauver');
        const btnClass = entry.qualityMismatch ? 'mini-btn mini-btn-warn' : 'mini-btn';
        if (entry.isPlaylist) {
          const save = document.createElement('button');
          save.type = 'button';
          save.className = btnClass;
          save.textContent = label;
          save.addEventListener('click', () => saveViaBlob(entry));
          actions.appendChild(save);
        } else {
          const save = document.createElement('a');
          save.href = `/api/file/${entry.downloadId}`;
          save.className = btnClass;
          save.textContent = label;
          save.addEventListener('click', () => { entry.saved = true; persist(); });
          actions.appendChild(save);
        }
      }
      if (entry.status === 'done' || entry.status === 'error' || entry.status === 'cancelled') {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'dlq-dismiss';
        close.innerHTML = ICON_CLOSE;
        close.title = 'Retirer';
        close.addEventListener('click', () => remove(entry.id));
        actions.appendChild(close);
      }

      row.append(thumb, body, actions);
      listEl.appendChild(row);
    });
  }

  // ── Téléchargements rapides (réglages "optimal" par défaut, sans écran
  // de réglages) — appelés depuis les boutons ⬇ sur les cartes résultat ──
  async function quickDownloadYoutube(url, meta) {
    const entry = add({ service: 'ytdown', autoSave: true, ...meta });
    try {
      const infoRes = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      const info = await infoRes.json();
      if (!infoRes.ok || info.error) throw new Error(info.error || 'Analyse impossible');
      if (info.type === 'spotify') {
        remove(entry.id);
        return quickDownloadSpotify(url, meta);
      }
      const mode = info.type === 'playlist' ? 'playlist' : 'single';
      const res = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, format: 'best', quality: '1080', mode }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Le téléchargement n’a pas pu démarrer.');
      attach(entry, data.download_id);
    } catch (e) {
      fail(entry, e.message);
    }
  }

  async function quickDownloadSpotify(url, meta) {
    const entry = add({ service: 'spotiflac', autoSave: true, ...meta });
    try {
      const infoRes = await fetch(`/api/music_info?url=${encodeURIComponent(url)}`);
      const spoti = await infoRes.json();
      if (!infoRes.ok || spoti.error) throw new Error(spoti.error || 'Impossible d’analyser ce lien Spotify.');
      const res = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spoti_data: {
            ...spoti,
            settings: {
              services: ['ext:tidal-web', 'ext:qobuz-web', 'ext:amazon', 'ext:deezer'],
              source_quality: 'LOSSLESS', transcode_to: 'flac', transcode_bitrate: '320k',
              embed_lyrics: true, use_track_numbers: true, use_album_track_numbers: true,
              allow_fallback: true, include_featuring: true, max_concurrent_downloads: 2,
            },
          },
          format: 'flac', quality: 'LOSSLESS', mode: 'spoti_album',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Le téléchargement n’a pas pu démarrer.');
      attach(entry, data.download_id);
    } catch (e) {
      fail(entry, e.message);
    }
  }

  async function quickDownloadDeemix(url, meta) {
    const entry = add({ service: 'deemix', autoSave: true, ...meta });
    try {
      const res = await fetch('/api/deemix/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url, quality: 'FLAC',
          settings: { embed_lyrics: true, save_lrc: false, artist_folders: false, album_folders: true, playlist_folders: false, keep_featuring: true, allow_fallback: true, concurrency: 3 },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Le téléchargement n’a pas pu démarrer.');
      attach(entry, data.download_id);
    } catch (e) {
      fail(entry, e.message);
    }
  }

  // ── Réglage "Télécharger automatiquement à la fin" centralisé ──────────
  // Une seule case, partagée entre les 3 pages (même origine → même
  // localStorage) : la décocher sur l'une la décoche partout. Chaque page
  // garde son propre <input data-auto-dl id="..."> pour le style/layout,
  // mais l'état vient d'ici et se resynchronise même entre onglets déjà
  // ouverts (évènement "storage").
  const AUTO_DL_KEY = 'ytdown_auto_dl_v1';

  function getAutoDl() {
    const v = localStorage.getItem(AUTO_DL_KEY);
    return v === null ? true : v === '1';
  }
  function setAutoDl(value) {
    try { localStorage.setItem(AUTO_DL_KEY, value ? '1' : '0'); } catch { /* quota/private mode */ }
  }
  function syncAutoDlCheckboxes() {
    const value = getAutoDl();
    document.querySelectorAll('[data-auto-dl]').forEach((box) => { box.checked = value; });
  }
  function initAutoDl() {
    syncAutoDlCheckboxes();
    document.querySelectorAll('[data-auto-dl]').forEach((box) => {
      box.addEventListener('change', () => setAutoDl(box.checked));
    });
  }
  window.addEventListener('storage', (event) => {
    if (event.key === AUTO_DL_KEY) syncAutoDlCheckboxes();
  });

  window.DLQueue = { add, attach, fail, cancel, cancelById, remove, clearFinished, downloadViaApi, quickDownloadYoutube, quickDownloadSpotify, quickDownloadDeemix };

  document.addEventListener('DOMContentLoaded', () => {
    ensureUI();
    render();
    resumeAll();
    initAutoDl();
  });
})();

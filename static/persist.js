// Petit wrapper localStorage partagé par les 3 pages (YTDown/SpotiFLAC/Deemix)
// pour que la navigation, la recherche et les téléchargements en cours
// survivent à un rechargement ou une fermeture de fenêtre.
window.YTPersist = {
  save(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* stockage indisponible (navigation privée...) */ }
  },
  load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },
  clear(key) {
    try { localStorage.removeItem(key); } catch (e) { /* rien à faire */ }
  },
  // Vrai uniquement pour un retour arrière/avant du navigateur — pas pour un
  // simple rechargement ou une arrivée directe sur la page.
  isBackForward() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      return !!nav && nav.type === 'back_forward';
    } catch (e) {
      return false;
    }
  },
};

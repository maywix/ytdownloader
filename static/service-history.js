// Historique propre à chaque service : accueil → recherche → fiche → téléchargement.
// L'entrée « limite » garde Retour sur l'accueil du service, même si on insiste.
window.YTServiceHistory = {
  create(service, onNavigate) {
    const key = '__ytdown_service';
    const base = window.location.pathname + window.location.search;
    const read = () => {
      const state = window.history.state;
      return state && state[key] && state[key].service === service ? state[key] : null;
    };
    const urlFor = (view) => base + (view === 'home' ? '' : `#${view}`);

    if (!read()) {
      window.history.replaceState({ [key]: { service, view: 'limit' } }, '', base);
      window.history.pushState({ [key]: { service, view: 'home' } }, '', base);
    } else if (read().view === 'limit') {
      window.history.pushState({ [key]: { service, view: 'home' } }, '', base);
    }

    window.addEventListener('popstate', () => {
      const state = read();
      if (state && state.view === 'limit') {
        window.history.forward();
      } else if (state) {
        onNavigate(state.view, state);
      }
    });

    return {
      current: () => read() || { service, view: 'home' },
      push(view, data = {}) {
        const state = { service, view, ...data };
        if (read()?.view === view) {
          window.history.replaceState({ [key]: state }, '', urlFor(view));
        } else {
          window.history.pushState({ [key]: state }, '', urlFor(view));
        }
      },
      replace(view, data = {}) {
        window.history.replaceState({ [key]: { service, view, ...data } }, '', urlFor(view));
      },
      back() {
        if (read()?.view !== 'home') window.history.back();
      },
    };
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const wrap = document.getElementById('service-switch');
  if (!wrap) return;
  const btn = document.getElementById('service-switch-btn');
  const menu = document.getElementById('service-menu');

  function close() {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  }

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
});

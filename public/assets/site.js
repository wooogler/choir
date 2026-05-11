document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (event) => {
    const target = document.querySelector(anchor.getAttribute('href'));
    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('access') !== 'choir2026') return;

  document.querySelectorAll('button.primary[disabled]').forEach((btn) => {
    btn.removeAttribute('disabled');
    btn.textContent = 'Add to Slack';
    btn.addEventListener('click', () => {
      window.location.href = '/slack/install';
    });
  });
})();

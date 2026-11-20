(function () {
  'use strict';

  const root = document.getElementById('profile');
  if (!root) return;

  const cards = [...root.querySelectorAll('.card')];
  const current = root.querySelector('[data-current]');
  const total = root.querySelector('[data-total]');
  const SHIFT = 14;
  const n = cards.length;
  let index = Math.max(0, cards.findIndex((c) => c.classList.contains('is-active')));

  total.textContent = n;

  function show(next, dir) {
    next = ((next % n) + n) % n;
    if (next === index) return;
    const from = cards[index], to = cards[next];

    to.style.transition = 'none';
    to.style.transform = `translateX(${dir * SHIFT}px)`;
    void to.offsetWidth;
    to.style.transition = '';
    to.style.transform = '';
    from.style.transform = `translateX(${-dir * SHIFT}px)`;

    from.classList.remove('is-active');
    to.classList.add('is-active');
    index = next;
    current.textContent = index + 1;
  }

  const step = (d) => show(index + d, d);

  root.querySelectorAll('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => step(Number(btn.dataset.step)));
  });

  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  const stack = root.querySelector('.profile-cards');
  let sx = 0, sy = 0, tracking = false;
  stack.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    tracking = true; sx = e.clientX; sy = e.clientY;
  });
  stack.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  stack.addEventListener('pointercancel', () => { tracking = false; });
})();

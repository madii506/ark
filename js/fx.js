/* ARK motion: smooth scroll, reveals, nav, progress, cursor, card glow, magnetic buttons, rolling numbers. */
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
const frames = new Set();
export const onFrame = fn => { frames.add(fn); kick(); };
let ticking = false;
function kick() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
const pending = new Set();
function frame() {
  ticking = false;
  const y = scrollY, vh = innerHeight, H = document.documentElement.scrollHeight - vh;
  const bar = document.querySelector('.progress'); if (bar) bar.style.transform = `scaleX(${H > 0 ? Math.min(1, y / H) : 0})`;
  for (const el of pending) { const r = el.getBoundingClientRect(); if (r.top < vh * 0.92 && r.bottom > 0) { pending.delete(el); el.classList.add('shown'); el.dispatchEvent(new CustomEvent('shown')); } }
  frames.forEach(fn => { try { fn(y, vh); } catch (e) { } });
}
export function watch(root = document) { root.querySelectorAll('[data-r]:not(.shown)').forEach(el => pending.add(el)); kick(); }

// digits roll before they settle
export function roll(el, text, ms = 900) {
  if (!el) return;
  const fin = String(text);
  if (RM || el.dataset.rolled === fin) { el.textContent = fin; return; }
  el.dataset.rolled = fin;
  const t0 = performance.now(), D = '0123456789';
  const step = t => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = [...fin].map((c, i) => (/\d/.test(c) && k < 0.3 + 0.7 * (i + 1) / fin.length ? D[(Math.random() * 10) | 0] : c)).join('');
    if (k < 1) requestAnimationFrame(step); else el.textContent = fin;
  };
  requestAnimationFrame(step);
}

function smooth() {
  if (RM || !FINE) return;
  const s = document.createElement('script'); s.src = '/vendor/lenis.min.js'; s.async = true;
  s.onload = () => {
    if (!window.Lenis) return;
    const lenis = new window.Lenis({ lerp: 0.09, anchors: { offset: -70 }, prevent: n => !!(n.closest && n.closest('.modal, .tbl-wrap, textarea, [data-lenis-prevent]')) });
    window.__lenis = lenis; lenis.on('scroll', kick);
    const raf = t => { lenis.raf(t); requestAnimationFrame(raf); }; requestAnimationFrame(raf);
  };
  document.head.appendChild(s);
}
let lastY = 0, navEl = null, pill = null, pillFor;
function navFrame(y) {
  if (!navEl) return;
  navEl.classList.toggle('solid', y > 12);
  const open = document.querySelector('.links.open');
  if (!open && y > 280 && y > lastY + 6) navEl.classList.add('tuck'); else if (y < lastY - 6 || y < 280) navEl.classList.remove('tuck');
  lastY = y;
  const a = navEl.querySelector('.links a:hover') || navEl.querySelector('.links a.on');
  if (pill && a !== pillFor) {
    pillFor = a;
    if (!a) { pill.style.opacity = 0; return; }
    const lr = a.parentElement.getBoundingClientRect(), r = a.getBoundingClientRect();
    pill.style.opacity = 1; pill.style.transform = `translateX(${(r.left - lr.left).toFixed(1)}px)`; pill.style.width = r.width.toFixed(1) + 'px';
  }
}
function faq() {
  document.querySelectorAll('.faq details').forEach(d => {
    const s = d.querySelector('summary'), body = d.querySelector('p'); if (!s || !body || RM) return;
    s.addEventListener('click', e => {
      e.preventDefault();
      if (d.open) { const h = body.offsetHeight; body.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.4,0,.2,1)' }).onfinish = () => { d.open = false; }; }
      else { d.open = true; const h = body.offsetHeight; body.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
    });
  });
}
function magnets() {
  if (RM || !FINE) return;
  document.addEventListener('pointermove', e => {
    const b = e.target.closest && e.target.closest('.btn.lg'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect();
    b.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * 0.16).toFixed(1)}px, ${((e.clientY - r.top - r.height / 2) * 0.26).toFixed(1)}px)`;
    b.onpointerleave = () => { b.style.transform = ''; };
  }, { passive: true });
}
function cursor() {
  if (RM || !FINE) return;
  const ring = document.createElement('div'); ring.className = 'cursor'; ring.setAttribute('aria-hidden', 'true'); document.body.appendChild(ring);
  let tx = -100, ty = -100, x = -100, y = -100, on = false, run = false;
  const loop = () => { x += (tx - x) * 0.22; y += (ty - y) * 0.22; ring.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`; if (Math.abs(tx - x) + Math.abs(ty - y) > 0.3) requestAnimationFrame(loop); else run = false; };
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return; tx = e.clientX; ty = e.clientY;
    const hot = !!(e.target.closest && e.target.closest('a, button, summary, label, select, input, textarea, .coin, tbody tr'));
    if (hot !== on) { on = hot; ring.classList.toggle('hot', hot); }
    ring.classList.add('show'); if (!run) { run = true; requestAnimationFrame(loop); }
  }, { passive: true });
  document.addEventListener('pointerleave', () => ring.classList.remove('show'));
}
export function fx() {
  document.documentElement.classList.add('fx');
  smooth(); faq(); magnets(); cursor();
  navEl = document.querySelector('.nav');
  const links = document.querySelector('.links');
  if (links) { pill = document.createElement('span'); pill.className = 'pill'; links.prepend(pill); links.addEventListener('pointerover', kick); links.addEventListener('pointerleave', () => { pillFor = undefined; kick(); }); }
  onFrame(navFrame);
  const bar = document.createElement('div'); bar.className = 'progress'; bar.setAttribute('aria-hidden', 'true'); document.body.appendChild(bar);
  watch();
  addEventListener('scroll', kick, { passive: true }); addEventListener('resize', kick);
  let n = 0; const iv = setInterval(() => { kick(); if (++n > 16) clearInterval(iv); }, 300);
  if (!RM) document.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const c = e.target.closest && e.target.closest('.card'); if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--gx', (e.clientX - r.left).toFixed(0) + 'px'); c.style.setProperty('--gy', (e.clientY - r.top).toFixed(0) + 'px');
  }, { passive: true });
  requestAnimationFrame(() => document.documentElement.classList.add('ready'));
}
export const reduced = RM;

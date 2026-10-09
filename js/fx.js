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
  setTimeout(() => motion(), 0);
}
export const reduced = RM;

/* ================= motion pass ================= */
// headings: split into words that rise out of a mask
export function split(root = document) {
  root.querySelectorAll('.h2:not(.splitw), [data-split]:not(.splitw)').forEach(el => {
    let i = 0;
    const walk = (node, gold) => {
      [...node.childNodes].forEach(n => {
        if (n.nodeType === 3) {
          const parts = n.textContent.split(/(\s+)/); const frag = document.createDocumentFragment();
          parts.forEach(p => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); return; }
            const w = document.createElement('span'); w.className = 'w';
            const inner = document.createElement('span'); inner.textContent = p; inner.style.setProperty('--i', i++);
            if (gold) inner.className = 'gold-w';
            w.appendChild(inner); frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') {
          const g = gold || n.classList.contains('gold');
          if (n.classList.contains('gold')) { n.classList.remove('gold'); }
          walk(n, g);
        }
      });
    };
    walk(el, false);
    el.classList.add('splitw');
    if (!el.hasAttribute('data-r') && !el.closest('[data-r]')) { el.setAttribute('data-r', 'fade'); }
  });
}
// kicker labels: letters scramble into place when they appear
const GLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$·';
export function scrambleText(el, ms = 700) {
  if (RM || el.dataset.scr) return; el.dataset.scr = 1;
  const nodes = []; const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) if (n.textContent.trim()) nodes.push([n, n.textContent]);
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / ms);
    nodes.forEach(([node, fin]) => { node.textContent = [...fin].map((c, i) => (c === ' ' || c === ' ' || k > (i + 1) / fin.length * 0.8 + 0.2 ? c : GLY[(Math.random() * GLY.length) | 0])).join(''); });
    if (k < 1) requestAnimationFrame(step); else nodes.forEach(([node, fin]) => { node.textContent = fin; });
  };
  requestAnimationFrame(step);
}
function kicks() {
  document.querySelectorAll('.kick').forEach(k => {
    const host = k.closest('[data-r]');
    if (!host) { setTimeout(() => scrambleText(k, 900), 250); return; }
    host.addEventListener('shown', () => scrambleText(k), { once: true });
  });
}
// give staggered children their order
export function stagger(root = document) {
  root.querySelectorAll('[data-stagger]').forEach(g => { [...g.children].forEach((c, i) => c.style.setProperty('--i', i)); if (!g.hasAttribute('data-r')) { g.setAttribute('data-r', 'fade'); pending.add(g); } });
  kick();
}
// scroll velocity, shared by anything that wants to react to it
export const vel = { v: 0 };
let vy = scrollY, vt = performance.now();
function velFrame() {
  const t = performance.now(), dy = scrollY - vy, dt = Math.max(16, t - vt);
  vel.v += ((dy / dt) * 16 - vel.v) * 0.2; vy = scrollY; vt = t;
  vel.v *= 0.92;
  requestAnimationFrame(velFrame);
}
// big text bands slide with the scroll, rows in opposite directions
function bands() {
  document.querySelectorAll('[data-band]').forEach(b => {
    const rows = [...b.querySelectorAll('.band-row')];
    rows.forEach(r => { r.innerHTML = r.innerHTML + r.innerHTML + r.innerHTML; });
    let x = 0;
    onFrame((y, vh) => {
      const r = b.getBoundingClientRect(); if (r.bottom < -50 || r.top > vh + 50) return;
      const base = (vh - r.top) * 0.45;
      rows.forEach((row, i) => { const w = row.scrollWidth / 3; const dir = i % 2 ? 1 : -1; let off = (base * dir) % w; if (dir < 0) off -= w * 0.15; else off -= w * 0.85; row.style.transform = `translate3d(${off.toFixed(1)}px,0,0) skewX(${Math.max(-8, Math.min(8, vel.v * -0.35)).toFixed(2)}deg)`; });
    });
    void x;
  });
}
// the footer word tightens and catches the light as it arrives
function bigWord() {
  const big = document.querySelector('.big-word'); if (!big || RM) return;
  onFrame((y, vh) => {
    const r = big.getBoundingClientRect(); if (r.top > vh || r.bottom < 0) return;
    const p = Math.max(0, Math.min(1, (vh - r.top) / (vh * 0.85)));
    big.style.letterSpacing = (0.25 - 0.31 * p).toFixed(3) + 'em';
    big.style.backgroundPosition = `${(100 - p * 100).toFixed(1)}% 0`;
  });
}
// hero copy drifts up and fades as you scroll away
function heroParallax() {
  const h = document.querySelector('.hero-copy'); if (!h || RM) return;
  onFrame(y => { if (y > innerHeight * 1.3) return; h.style.transform = `translate3d(0,${(y * 0.22).toFixed(1)}px,0)`; h.style.opacity = Math.max(0, 1 - y / (innerHeight * 0.9)).toFixed(3); });
}
// gold dust drifting through the whole page
function dust() {
  if (RM) return;
  const cv = document.createElement('canvas'); cv.id = 'dust'; cv.setAttribute('aria-hidden', 'true'); document.body.prepend(cv);
  const x = cv.getContext('2d'); let w = 0, h = 0; const d = Math.min(devicePixelRatio || 1, 1.5);
  const fit = () => { w = innerWidth; h = innerHeight; cv.width = w * d; cv.height = h * d; x.setTransform(d, 0, 0, d, 0, 0); };
  fit(); addEventListener('resize', fit);
  const N = innerWidth < 700 ? 26 : 54;
  const P = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, s: 0.4 + Math.random() * 1.4, p: Math.random() * 6.28 }));
  let last = 0;
  const f = t => {
    requestAnimationFrame(f);
    if (document.hidden || t - last < 40) return; last = t;
    x.clearRect(0, 0, w, h);
    const sy = scrollY;
    for (const q of P) {
      q.y -= 0.00022 * q.z * 40 / 16; q.p += 0.02;
      if (q.y < -0.05) { q.y = 1.05; q.x = Math.random(); }
      const px = (q.x + Math.sin(q.p) * 0.004) * w, py = ((q.y * h - sy * q.z * 0.25) % h + h) % h;
      const a = 0.18 + 0.32 * Math.sin(q.p * 0.7) ** 2;
      x.beginPath(); x.arc(px, py, q.s * q.z, 0, 6.283); x.fillStyle = `rgba(232,200,128,${(a * q.z).toFixed(3)})`; x.fill();
    }
  };
  requestAnimationFrame(f);
}
export function motion() {
  split(); stagger(); kicks(); bands(); bigWord(); heroParallax(); dust();
  requestAnimationFrame(velFrame);
  watch();
}

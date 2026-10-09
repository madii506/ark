import { $$, chrome } from './core.js';
import { fx } from './fx.js';
const cfg = await chrome('docs');
fx();
const V = {
  devMaxSol: cfg.devMaxSol != null ? cfg.devMaxSol : 1, perWallet: cfg.perWallet || 50, perTicker: cfg.perTicker || 2,
  registry: cfg.registry || '…', maxCurveDepth: cfg.pump ? cfg.pump.maxCurveDepth : 1, ca: cfg.ca || 'at launch',
  protocol: cfg.fees ? (cfg.fees.protocol / 100).toFixed(2) + '%' : '—', creator: cfg.fees ? (cfg.fees.creator / 100).toFixed(2) + '%' : '—',
};
$$('[data-v]').forEach(el => { const v = V[el.dataset.v]; if (v != null) el.textContent = v; });
const links = $$('#toc a');
const on = () => { let cur = links[0]; for (const a of links) { const s = document.querySelector(a.getAttribute('href')); if (s && s.getBoundingClientRect().top < 160) cur = a; } links.forEach(a => a.classList.toggle('on', a === cur)); };
addEventListener('scroll', on, { passive: true }); on();

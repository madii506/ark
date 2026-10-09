/* Shared pieces: coin cards, tape chips, badges. */
import { esc, usd, num, pct, pctCls, ago, img, short } from './core.js';

export function badges(c, { all = false } = {}) {
  const k = c.checks || {};
  const out = [];
  if (k.paired) out.push('<span class="tag gold">✓ $ARK pair</span>');
  if (k.holders) out.push('<span class="tag ok">✓ fees→holders</span>');
  if (k.dev === true) out.push('<span class="tag ok">✓ dev ≤ 3%</span>'); else if (k.dev === false) out.push('<span class="tag bad">dev &gt; 3%</span>');
  if (all && k.registry) out.push('<span class="tag">via ARK</span>');
  return out.join('');
}
export function pic(c, cls = '') { return c.image ? `<img class="${cls}" src="${esc(img(c.image))}" alt="" loading="lazy" decoding="async">` : `<div class="ph ${cls}">${esc((c.symbol || '?').slice(0, 3))}</div>`; }
export function coinCard(c) {
  const cv = c.curve || {};
  const prog = Math.round((cv.progress || 0) * 100);
  return `<a class="card coin" href="/coin?m=${esc(c.mint)}" data-mint="${esc(c.mint)}">
    <div class="coin-top">${pic(c)}<div><b>$${esc(c.symbol)}</b><span>${esc(c.name)}</span></div><span class="tag">${ago(c.t)}</span></div>
    <div class="coin-num"><div><small>Mkt cap</small><b>${usd(c.mcapUsd)}</b></div><div><small>In $ARK</small><b>${num(cv.mcapArk)}</b></div><div><small>24h</small><b class="${pctCls(c.chg24)}">${pct(c.chg24)}</b></div></div>
    <div class="grid" style="gap:7px"><div style="display:flex;justify-content:space-between;font:500 11.5px/1 JBM;color:var(--mu)"><span>${cv.complete || cv.migrated ? 'Graduated' : 'Bonding curve'}</span><span>${prog}%</span></div><div class="prog"><i style="width:${prog}%"></i></div></div>
    <div class="badges">${badges(c)}</div>
  </a>`;
}
export function chip(c) { return `<a class="chip" href="/coin?m=${esc(c.mint)}">${pic(c)}<b><i>$</i>${esc(c.symbol)}</b><span>${usd(c.mcapUsd)}</span></a>`; }
export function ghostChips(n = 10) { return Array.from({ length: n }, (_, i) => `<span class="chip ghost"><span class="ph">${String(i + 1).padStart(2, '0')}</span><b><i>$</i>SEAT</b><span>open</span></span>`).join(''); }
export function emptyBoard(prelaunch) {
  return `<div class="empty"><b>${prelaunch ? 'Boarding opens when $ARK is live.' : 'The first seat is still open.'}</b><span>${prelaunch ? 'Fill in your coin now and run the gangway. The launch button unlocks at $ARK launch.' : 'Launch the first coin paired to $ARK.'}</span><div class="seats">${Array.from({ length: 6 }, (_, i) => `<i>${String(i + 1).padStart(2, '0')}</i>`).join('')}</div><a class="btn gold" href="/launch" style="margin-top:8px">Launch a coin <span class="arr">→</span></a></div>`;
}
// endless tape: duplicate content and slide it, speed in px/s
export function tape(track, html, speed = 38) {
  track.innerHTML = html + html;
  let x = 0, last = performance.now(), w = track.scrollWidth / 2, hover = false;
  track.onpointerenter = () => { hover = true; }; track.onpointerleave = () => { hover = false; };
  if (track._raf) cancelAnimationFrame(track._raf);
  const step = t => {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    if (!document.hidden) { x -= (hover ? speed * 0.25 : speed) * dt; if (-x >= w) x += w; track.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`; }
    track._raf = requestAnimationFrame(step);
  };
  requestAnimationFrame(() => { w = track.scrollWidth / 2 || 1; track._raf = requestAnimationFrame(step); });
}
export { short };

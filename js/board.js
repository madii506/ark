import { $, $$, esc, usd, num, pct, pctCls, ago, api, chrome } from './core.js';
import { fx, watch } from './fx.js';
import { coinCard, emptyBoard, pic, badges } from './ui.js';

const cfg = await chrome('board');
fx();
const S = { list: [], sort: 'mcap', filt: 'all', view: 'grid', q: '' };
try { const v = localStorage.getItem('ark.view'); if (v) S.view = v; } catch (e) { }
let prev = {};

function rows() {
  let l = S.list.slice();
  const q = S.q.trim().toLowerCase();
  if (q) l = l.filter(c => (c.symbol || '').toLowerCase().includes(q.replace(/^\$/, '')) || (c.name || '').toLowerCase().includes(q) || c.mint.toLowerCase() === q);
  if (S.filt === 'ark') l = l.filter(c => c.pair && c.pair.main);
  if (S.filt === 'other') l = l.filter(c => c.pair && !c.pair.main);
  if (S.filt === 'curve') l = l.filter(c => c.curve && !c.curve.complete && !c.curve.migrated);
  if (S.filt === 'grad') l = l.filter(c => c.curve && (c.curve.complete || c.curve.migrated));
  const key = { mcap: c => c.mcapUsd || 0, new: c => c.t || 0, prog: c => (c.curve && c.curve.progress) || 0, locked: c => (c.curve && c.curve.arkLocked) || 0 }[S.sort];
  return l.sort((a, b) => key(b) - key(a));
}
function render() {
  const box = $('#list');
  if (!S.list.length) { box.innerHTML = emptyBoard(!cfg.ca); return; }
  const l = rows();
  if (!l.length) { box.innerHTML = '<div class="empty"><b>No coins match.</b><span>Try another search or filter.</span></div>'; return; }
  if (S.view === 'grid') box.innerHTML = `<div class="coins">${l.map(coinCard).join('')}</div>`;
  else box.innerHTML = `<div class="tbl-wrap" data-lenis-prevent><table class="table"><thead><tr><th>#</th><th>Coin</th><th>Pair</th><th>Mkt cap</th><th>In pair</th><th>24h</th><th>Progress</th><th>$ARK locked</th><th>Checks</th><th>Age</th></tr></thead><tbody>${l.map((c, i) => {
    const cv = c.curve || {};
    return `<tr data-mint="${esc(c.mint)}"><td class="mu">${i + 1}</td><td><div style="display:flex;gap:10px;align-items:center">${pic(c).replace('<img ', '<img style="width:30px;height:30px;border-radius:9px" ').replace('class="ph ', 'style="width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font:500 10px JBM;border:1px dashed var(--line3)" class="')}<b>$${esc(c.symbol)}</b><span class="mu">${esc(c.name)}</span></div></td><td>${c.pair ? (c.pair.main ? '<span class="tag gold">$ARK</span>' : '<span class="tag">$' + esc(c.pair.symbol) + '</span>') : '—'}</td><td>${usd(c.mcapUsd)}</td><td>${num(cv.mcapArk)}</td><td class="${pctCls(c.chg24)}">${pct(c.chg24)}</td><td>${Math.round((cv.progress || 0) * 100)}%</td><td>${num(cv.arkLocked)}</td><td><div class="badges">${badges(c)}</div></td><td class="mu">${ago(c.t)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  $$('tr[data-mint]').forEach(tr => tr.onclick = () => { location.href = '/coin?m=' + tr.dataset.mint; });
  // flash coins whose market cap moved since the last refresh
  l.forEach(c => { const p = prev[c.mint]; if (p != null && c.mcapUsd != null && Math.abs(c.mcapUsd - p) / (p || 1) > 0.002) { const el = $(`[data-mint="${c.mint}"]`); el && el.classList.add('flash'); } });
  prev = Object.fromEntries(l.map(c => [c.mint, c.mcapUsd]));
}
function stats(d) {
  const t = d.totals || {};
  $('#bsCoins').textContent = t.coins != null ? t.coins : '0';
  $('#bsLocked').textContent = num(t.arkLocked || 0) + ' $ARK';
  if (t.onArk != null) $('#bsCoins').textContent = `${t.coins} · ${t.onArk} on $ARK`;
  $('#bsGrad').textContent = t.graduated != null ? t.graduated : '0';
  $('#bsHold').textContent = cfg.fees ? (cfg.fees.creator / 100).toFixed(2) + '% of trades' : '—';
}
async function load() {
  try { const d = await api('coins'); S.list = d.list || []; stats(d); render(); }
  catch (e) { if (!S.list.length) $('#list').innerHTML = `<div class="empty"><b>Could not reach the chain.</b><span>${esc(e.message)}</span></div>`; }
}
const seg = (id, key, attr) => $$(`#${id} button`).forEach(b => b.onclick = () => { S[key] = b.dataset[attr]; $$(`#${id} button`).forEach(x => x.classList.toggle('on', x === b)); if (key === 'view') { try { localStorage.setItem('ark.view', S.view); } catch (e) { } } render(); });
seg('sort', 'sort', 's'); seg('filt', 'filt', 'f'); seg('view', 'view', 'v');
$$('#view button').forEach(x => x.classList.toggle('on', x.dataset.v === S.view));
let tm = 0; $('#q').addEventListener('input', e => { clearTimeout(tm); tm = setTimeout(() => { S.q = e.target.value; render(); }, 120); });
$('#list').innerHTML = '<div class="coins">' + Array.from({ length: 6 }, () => '<div class="card coin"><div class="skel" style="height:58px"></div><div class="skel" style="height:40px"></div><div class="skel" style="height:8px"></div></div>').join('') + '</div>';
load(); setInterval(() => { if (!document.hidden) load(); }, 15000);
watch();

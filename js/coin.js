import { $, $$, esc, usd, num, sig, pct, pctCls, ago, api, toast, copy, W, addr, ensureWallet, signWith, sendSigned, waitFor, solscan, cancelled, chrome, short, img } from './core.js';
import { fx, watch } from './fx.js';

const cfg = await chrome('coin');
fx();
const MINT = new URLSearchParams(location.search).get('m') || (location.pathname.match(/\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})/) || [])[1];
const T = { side: 'buy', via: 'SOL', d: null, bal: null };
const ICON = { true: '✓', false: '✕', null: '·' };

if (!MINT) $('#cpHead').innerHTML = '<div class="empty"><b>No coin selected.</b><a class="btn" href="/board">Open the board</a></div>';

function head(d) {
  const cv = d.curve || {};
  document.title = `$${d.symbol || 'COIN'} · ARK`;
  $('#cpHead').innerHTML = `<div class="cp-head">
    ${d.image ? `<img class="pic" src="${esc(img(d.image))}" alt="">` : '<div class="pic"></div>'}
    <div><h1>$${esc(d.symbol)} <span class="mu" style="font-weight:500;font-size:.5em;letter-spacing:-.01em">${esc(d.name)}</span></h1>
      <div class="sub"><button class="ca" id="mintChip">CA <b>${short(d.mint, 5)}</b><i>COPY</i></button>${cv.paired ? '<span class="tag gold">paired to $ARK</span>' : '<span class="tag bad">not paired to $ARK</span>'}${d.checks.holders ? '<span class="tag ok">fees → holders</span>' : ''}${d.viaArk ? '<span class="tag">launched via ARK</span>' : ''}${cv.complete || cv.migrated ? '<span class="tag gold">graduated</span>' : ''}</div></div>
    <div class="quick">${d.twitter ? `<a class="btn sm" href="${esc(d.twitter)}" target="_blank" rel="noopener nofollow">X ↗</a>` : ''}${d.telegram ? `<a class="btn sm" href="${esc(d.telegram)}" target="_blank" rel="noopener nofollow">Telegram ↗</a>` : ''}${d.website ? `<a class="btn sm" href="${esc(d.website)}" target="_blank" rel="noopener nofollow">Website ↗</a>` : ''}<a class="btn sm" href="https://pump.fun/coin/${esc(d.mint)}" target="_blank" rel="noopener">pump.fun ↗</a></div>
  </div>${d.description ? `<p class="mu" style="max-width:760px;margin:-6px 0 22px">${esc(d.description)}</p>` : ''}`;
  $('#mintChip').onclick = () => copy(d.mint, 'Contract address copied');
}
function stats(d) {
  const cv = d.curve || {}, m = d.market || {};
  const arkUsd = d.ark && d.ark.priceUsd;
  const priceArk = cv.priceArk;
  $('#cpStats').innerHTML = [
    ['Market cap', usd(m.mcapUsd || cv.mcapUsd), cv.mcapArk != null ? num(cv.mcapArk) + ' $ARK' : ''],
    ['Price', priceArk != null && arkUsd ? usd(priceArk * arkUsd) : usd(m.priceUsd), priceArk != null ? sig(priceArk) + ' $ARK' : ''],
    ['Bonding curve', Math.round((cv.progress || 0) * 100) + '%', cv.complete || cv.migrated ? 'graduated' : 'to graduation'],
    ['$ARK locked', num(cv.arkLocked || 0), 'in the curve'],
  ].map(([k, v, s]) => `<div class="stat card"><small>${k}</small><b>${v}</b><span class="mono mu" style="font-size:11.5px">${s}</span></div>`).join('');
}
function rewards(d) {
  const r = d.rewards, box = $('#cpRewards');
  if (!d.checks.holders) { box.innerHTML = '<span class="mu">This coin is not a holder-reward coin.</span>'; return; }
  if (!r) { box.innerHTML = '<span class="mu">Reading the holder pool…</span>'; return; }
  box.innerHTML = `<div class="sum"><div><span>Waiting for holders</span><b>${num(r.pending)} $ARK</b></div><div><span>Paid to holders</span><b>${num(r.paid)} $ARK</b></div><div><span>Payouts</span><b>${r.payouts}${r.lastPaid ? ` · last ${ago(r.lastPaid)} ago` : ''}</b></div><div><span>Fee per trade</span><b>${cfg.fees ? (cfg.fees.creator / 100).toFixed(2) + '%' : '—'}</b></div></div>
    <a class="mono" style="font-size:12px;color:var(--gold);display:inline-block;margin-top:12px" href="https://solscan.io/account/${esc(r.pda)}" target="_blank" rel="noopener">holder pool ${short(r.pda)} ↗</a>`;
}
function checks(d) {
  const k = d.checks;
  const rows = [
    [k.paired, 'Paired to $ARK', "The curve's quote mint is $ARK."],
    [k.holders, 'Fees to holders', 'Creator is the holder-rewards account. Permanent.'],
    [k.registry, 'Launched via ARK', k.registry ? 'Memo + registry tag in the create transaction.' : 'Not in the ARK registry.'],
    [k.dev, `Dev buy ≤ ${cfg.devCapPct || 3}%`, d.devPct != null ? `First buy: ${d.devPct.toFixed(2)}% of supply.` : 'Unknown for coins launched elsewhere.'],
    [k.mintAuth, 'No mint authority', 'Nobody can mint more.'],
    [k.freezeAuth, 'No freeze authority', 'Nobody can freeze wallets.'],
  ];
  $('#cpChecks').innerHTML = rows.map(([v, b, s]) => `<li class="ck ${v === true ? 'pass' : v === false ? 'fail' : 'wait'}"><span class="ic">${ICON[v]}</span><div><b>${esc(b)}</b><span>${esc(s)}</span></div></li>`).join('');
}
function holders(d) {
  const h = d.holders || [];
  $('#hN').textContent = d.creatorPct != null ? `creator holds ${d.creatorPct.toFixed(2)}%` : '';
  $('#cpHolders').innerHTML = h.length ? h.map(x => `<div><span class="mono">${x.curve ? 'bonding curve' : x.creator ? 'creator ' + short(x.owner) : short(x.owner)}</span><b>${x.pct.toFixed(2)}%</b><i style="--w:${Math.min(100, x.pct).toFixed(2)}%"></i></div>`).join('') : '<span class="mu">No holder data yet.</span>';
}
function trades(d) {
  const t = d.trades || [];
  $('#trN').textContent = t.length ? `last ${t.length}` : '';
  $('#cpTrades').innerHTML = t.length ? t.slice(0, 25).map(x => `<div><span class="${x.buy ? 'up' : 'down'}" style="font-weight:700">${x.buy ? 'Buy' : 'Sell'}</span><span>${num(x.ark)} $ARK</span><span class="mu">${num(x.tokens)} $${esc(d.symbol)}</span><a class="mono mu" style="font-size:12px;text-align:right" href="${solscan(x.sig)}" target="_blank" rel="noopener">${ago(x.t)} ↗</a></div>`).join('') : '<span class="mu">No trades yet.</span>';
  chart(t.slice().sort((a, b) => a.t - b.t));
}
/* price chart from on-chain trades */
let CH = null, drawn = false;
function chart(pts, prog) {
  if (!drawn && prog == null && pts.length > 1) { drawn = true; const t0 = performance.now(); const f = t => { const k = Math.min(1, (t - t0) / 1200); chart(pts, 1 - Math.pow(1 - k, 3)); if (k < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); return; }
  prog = prog == null ? 1 : prog;
  const cv = $('#chartCv'), box = $('#chart'), tip = $('#tip');
  const r = box.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
  if (pts.length < 2) { x.fillStyle = '#6d6963'; x.font = '500 13px JBM'; x.textAlign = 'center'; x.fillText(pts.length ? 'One trade so far' : 'Waiting for the first trades', r.width / 2, r.height / 2); CH = null; return; }
  const ps = pts.map(p => p.price), lo = Math.min(...ps), hi = Math.max(...ps), pad = (hi - lo) * 0.12 || hi * 0.05;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const X = t => 8 + (r.width - 16) * ((t - t0) / Math.max(1, t1 - t0)), Y = p => 14 + (r.height - 40) * (1 - (p - (lo - pad)) / ((hi + pad) - (lo - pad)));
  x.strokeStyle = 'rgba(255,255,255,.05)'; x.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const yy = 14 + (r.height - 40) * i / 3; x.beginPath(); x.moveTo(0, yy); x.lineTo(r.width, yy); x.stroke(); }
  x.save(); x.beginPath(); x.rect(0, 0, r.width * prog, r.height); x.clip();
  const g = x.createLinearGradient(0, 0, 0, r.height); g.addColorStop(0, 'rgba(216,179,106,.32)'); g.addColorStop(1, 'rgba(216,179,106,0)');
  x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(X(p.t), Y(p.price)) : x.moveTo(X(p.t), Y(p.price)))); x.lineTo(X(t1), r.height); x.lineTo(X(t0), r.height); x.closePath(); x.fillStyle = g; x.fill();
  x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(X(p.t), Y(p.price)) : x.moveTo(X(p.t), Y(p.price)))); x.strokeStyle = '#e9c97f'; x.lineWidth = 2; x.stroke();
  pts.forEach(p => { x.beginPath(); x.arc(X(p.t), Y(p.price), 2.2, 0, 6.283); x.fillStyle = p.buy ? '#7fe0a6' : '#ff7a6e'; x.fill(); });
  x.restore();
  x.fillStyle = '#6d6963'; x.font = '500 11px JBM'; x.textAlign = 'left'; x.fillText(sig(hi) + ' $ARK', 8, 12); x.fillText(sig(lo) + ' $ARK', 8, r.height - 6);
  CH = { pts, X, Y };
  box.onpointermove = e => {
    if (!CH) return; const bx = e.clientX - r.left; let best = CH.pts[0];
    for (const p of CH.pts) if (Math.abs(CH.X(p.t) - bx) < Math.abs(CH.X(best.t) - bx)) best = p;
    tip.style.opacity = 1; tip.style.left = Math.min(r.width - 170, Math.max(0, CH.X(best.t) + 10)) + 'px'; tip.style.top = Math.max(0, CH.Y(best.price) - 46) + 'px';
    tip.innerHTML = `${best.buy ? '<span class="up">Buy</span>' : '<span class="down">Sell</span>'} · ${ago(best.t)} ago<br>${sig(best.price)} $ARK · ${num(best.ark)} $ARK`;
  };
  box.onpointerleave = () => { tip.style.opacity = 0; };
}

/* ---------- trading ---------- */
function paintTrade() {
  const d = T.d, sym = d ? d.symbol : 'COIN';
  $$('#side button').forEach(b => b.classList.toggle('on', b.dataset.s === T.side));
  $$('#via button').forEach(b => b.classList.toggle('on', b.dataset.v === T.via));
  $('#via').querySelector('[data-v="SOL"]').textContent = T.side === 'buy' ? 'with SOL' : 'for SOL';
  $('#via').querySelector('[data-v="ARK"]').textContent = T.side === 'buy' ? 'with $ARK' : 'for $ARK';
  $('#amtUnit').textContent = T.side === 'buy' ? (T.via === 'SOL' ? 'SOL' : '$ARK') : '$' + sym;
  $('#qRoute').textContent = T.side === 'buy' ? (T.via === 'SOL' ? `SOL → $ARK → $${sym}` : `$ARK → $${sym}`) : (T.via === 'SOL' ? `$${sym} → $ARK → SOL` : `$${sym} → $ARK`);
  const q = $('#quick');
  if (T.side === 'buy') q.innerHTML = (T.via === 'SOL' ? [0.1, 0.5, 1, 2] : [1000, 10000, 100000]).map(v => `<button data-v="${v}">${num(v)}</button>`).join('');
  else q.innerHTML = [25, 50, 100].map(v => `<button data-p="${v}">${v}%</button>`).join('');
  $$('#quick button').forEach(b => b.onclick = async () => {
    if (b.dataset.v) { $('#amt').value = b.dataset.v; return quote(); }
    if (!W.acct) { try { await ensureWallet(); } catch (e) { return; } }
    await balances(); const have = T.bal && T.bal.token || 0;
    $('#amt').value = have ? +(have * b.dataset.p / 100).toFixed(6) : 0; quote();
  });
  const ok = d && d.curve && d.curve.paired && cfg.ca;
  $('#tGo').disabled = !ok;
  $('#tGo').textContent = !cfg.ca ? 'Trading opens when $ARK is live' : !ok ? 'Not paired to $ARK' : `${T.side === 'buy' ? 'Buy' : 'Sell'} $${sym}`;
}
async function balances() { if (!W.acct || !MINT) return; try { T.bal = await api(`bal?u=${addr()}&m=${MINT}`); } catch (e) { } }
let qTm = 0, qSeq = 0;
function quote() {
  clearTimeout(qTm);
  const v = parseFloat($('#amt').value);
  if (!(v > 0) || !cfg.ca || !T.d || !T.d.curve.paired) { $('#qOut').textContent = '—'; return; }
  if (T.side === 'sell' && !W.acct) { $('#qOut').textContent = 'connect to quote'; return; }
  $('#qOut').innerHTML = '<span class="skel">0000000</span>';
  qTm = setTimeout(async () => {
    const my = ++qSeq;
    try { const q = await api('quote', { kind: 'trade', mint: MINT, side: T.side, via: T.via, amount: v, user: addr() }); if (my !== qSeq) return; $('#qOut').textContent = `${num(q.out)} ${T.side === 'buy' ? '$' + T.d.symbol : T.via === 'SOL' ? 'SOL' : '$ARK'}`; }
    catch (e) { if (my === qSeq) $('#qOut').textContent = e.message.length > 40 ? '—' : e.message; }
  }, 400);
}
$$('#side button').forEach(b => b.onclick = () => { T.side = b.dataset.s; $('#amt').value = T.side === 'buy' ? (T.via === 'SOL' ? '0.1' : '1000') : ''; paintTrade(); quote(); });
$$('#via button').forEach(b => b.onclick = () => { T.via = b.dataset.v; if (T.side === 'buy') $('#amt').value = T.via === 'SOL' ? '0.1' : '1000'; paintTrade(); quote(); });
$('#amt').addEventListener('input', quote);
$('#slip').addEventListener('change', quote);
$('#tGo').onclick = async () => {
  const v = parseFloat($('#amt').value); if (!(v > 0)) return toast('Enter an amount', 'bad');
  const btn = $('#tGo'), t0 = btn.textContent; btn.disabled = true;
  try {
    await ensureWallet(); btn.textContent = 'Building…';
    const b = await api('trade', { user: addr(), mint: MINT, side: T.side, via: T.via, amount: v, slippage: +$('#slip').value });
    btn.textContent = 'Sign in your wallet…';
    const s = await sendSigned(await signWith(b.tx)); btn.textContent = 'Confirming…';
    await waitFor(s);
    toast(`Done: ${num(b.out)} ${T.side === 'buy' ? '$' + T.d.symbol : T.via === 'SOL' ? 'SOL' : '$ARK'}`, 'ok');
    load(); balances();
  } catch (e) { toast(cancelled(e) ? 'Cancelled in the wallet. Nothing was sent.' : e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = t0; paintTrade(); }
};
W.change.add(() => { balances(); quote(); });

async function load() {
  if (!MINT) return;
  try {
    const d = await api('coin?m=' + encodeURIComponent(MINT));
    const first = !T.d; T.d = d;
    head(d); stats(d); rewards(d); checks(d); holders(d); trades(d);
    if (first) { paintTrade(); quote(); }
    watch();
  } catch (e) {
    if (!T.d) $('#cpHead').innerHTML = `<div class="empty"><b>${e.status === 404 ? 'No pump.fun coin at this address.' : 'Could not load this coin.'}</b><span>${esc(e.message)}</span><a class="btn" href="/board">Open the board</a></div>`;
  }
}
if (MINT) {
  $('#cpHead').innerHTML = '<div class="cp-head"><div class="pic skel"></div><div><div class="skel" style="height:40px;width:260px"></div></div></div>';
  load(); setInterval(() => { if (!document.hidden) load(); }, 12000);
  addEventListener('resize', () => T.d && chart((T.d.trades || []).slice().sort((a, b) => a.t - b.t)));
}

import { $, $$, esc, usd, num, pct, pctCls, api, toast, copy, W, addr, ensureWallet, signWith, sendSigned, waitFor, solscan, cancelled, chrome, short, img } from './core.js';
import { fx, watch, roll, reduced, onFrame } from './fx.js';
import { coinCard, chip, pairChip, ghostChips, emptyBoard, tape } from './ui.js';

const cfg = await chrome('home');
fx();
const LIVE = !!cfg.ca;
const FEEP = ((cfg.feeBps != null ? cfg.feeBps : 500) / 100);
let ARK = null, COINS = null, PAIRS = null, LIVEST = null;

/* ---------- hero 3D (falls back to the flat mark) ---------- */
(async () => {
  try { const { hero3d } = await import('./hero3d.js'); if (!hero3d($('#stage'), { reduced })) throw new Error('no webgl'); }
  catch (e) { $('#stageFb').hidden = false; }
})();

/* ---------- live numbers ---------- */
function renderLive() {
  if (ARK && ARK.live) { $('#lvArk').textContent = usd(ARK.priceUsd); $('#lvArk2').textContent = ARK.mcapUsd ? usd(ARK.mcapUsd) + ' mcap' : 'live'; }
  else { $('#lvArk').textContent = '$ARK'; $('#lvArk2').textContent = 'main pair'; }
  const t = (COINS && COINS.totals) || { coins: 0, arkLocked: 0 };
  roll($('#lvCoins'), String(t.coins));
  $('#lvLocked').textContent = num(t.arkLocked);
  $('#lvFee').textContent = cfg.fees ? (cfg.fees.creator / 100).toFixed(2) + '%' : '—';
}
function renderTape() {
  const main = { mint: cfg.ca, symbol: 'ARK', image: '/img/icon-180.png' };
  const list = (PAIRS && PAIRS.list) || [];
  const html = pairChip(main, true) + (list.length ? list.slice(0, 22).map(p => pairChip(p)).join('') : ghostChips(8));
  const tr = $('#tapeTrack'); if (tr.dataset.h === html) return; tr.dataset.h = html; tape(tr, html, 36);
}
function renderPairs() {
  const a = ARK || { live: false }, list = (PAIRS && PAIRS.list) || [];
  $('#pMain').innerHTML = `<span class="kick">Main pair</span>
    <div class="big"><img src="/img/icon-180.png" alt=""><div><b>$ARK</b><div class="mu" style="font-size:14px;margin-top:6px">${a.live ? usd(a.mcapUsd) + ' market cap' : 'The coin every coin pairs with'}</div></div></div>
    <p class="mu" style="margin:0;font-size:15px">Pair with $ARK and every buy of your coin is also a buy of $ARK. 100% of your coin's creator fees still go to its holders.</p>
    <div class="badges">${a.live ? `<span class="tag ${a.pairable ? 'ok' : 'bad'}">${a.pairable ? '● pairable now' : '● paused'}</span>` : '<span class="tag gold">● main pair</span>'}<span class="tag">depth 1</span><span class="tag">fees → holders</span></div>
    <a class="btn gold" href="/launch">Launch paired to $ARK <span class="arr">→</span></a>`;
  $('#pCount').textContent = PAIRS ? `${list.length} real pump.fun coins` : 'checking…';
  $('#pGrid').innerHTML = list.length ? list.slice(0, 15).map(p => `<a class="pc" href="/launch?pair=${esc(p.mint)}">${p.image ? `<img src="${esc(p.image.startsWith('/') ? p.image : img(p.image))}" alt="" loading="lazy">` : `<span class="ph">${esc(p.symbol.slice(0, 3))}</span>`}<div><b>$${esc(p.symbol)}</b><span>${p.mcapUsd ? usd(p.mcapUsd) : '—'} · ${p.venue === 'curve' ? 'on curve' : 'PumpSwap'}</span></div><span class="go">Pair →</span></a>`).join('')
    : `<span class="mu">${PAIRS ? 'No other pump.fun coin is pairable right now.' : 'Checking pump.fun…'}</span>`;
}
function renderLiveState() {
  const L = LIVEST, box = $('#liveGrid'); if (!L) { box.innerHTML = Array.from({ length: 4 }, () => '<div class="card lv"><div class="skel" style="height:14px;width:60%"></div><div class="skel" style="height:30px"></div></div>').join(''); return; }
  const sc = L.scan || {};
  const pc = sc.trades ? sc.custom / sc.trades * 100 : null, hr = sc.trades ? sc.holderReward / sc.trades * 100 : null;
  box.innerHTML = [
    ['New coins', `<span class="dot-live"></span>${L.createV2 ? 'Open' : 'Paused'}`, `${sc.creates != null ? sc.creates + ' created' : 'pump.fun'} in the last ${sc.txs || '—'} transactions`, null],
    ['Custom-pair trades', pc != null ? pc.toFixed(0) + '%' : '—', `of the last ${sc.trades || '—'} pump.fun trades run on a pair other than SOL`, pc],
    ['Holder-reward trades', hr != null ? hr.toFixed(0) + '%' : '—', 'of those trades pay their creator fee to holders', hr],
    ['Fees per trade', L.fees ? `${(L.fees.protocol / 100).toFixed(2)}%<span class="mu" style="font-size:.5em"> + ${(L.fees.creator / 100).toFixed(2)}%</span>` : '—', `pump.fun protocol + creator fee. Pair depth: up to ${L.maxCurveDepth}.`, null],
  ].map(([k, v, t, bar]) => `<div class="card lv"><small>${k}</small><b>${v}</b><span>${t}</span>${bar != null ? `<div class="bar"><i style="width:${Math.min(100, bar).toFixed(1)}%"></i></div>` : ''}</div>`).join('');
}
function renderBoard() {
  const list = (COINS && COINS.list) || [];
  const box = $('#boardPrev');
  if (!list.length) { box.innerHTML = emptyBoard(!LIVE); return; }
  box.innerHTML = `<div class="coins">${list.slice().sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, 6).map(coinCard).join('')}</div>`;
}
function renderArk() {
  const a = ARK || { live: false };
  const p = a.live && a.progress != null ? a.progress : 0;
  $('#arkMain').innerHTML = `
    <span class="kick">Contract</span>
    <div class="ca-big" id="arkCa">${a.live ? esc(a.ca) + '<i>COPY</i>' : '<span class="mu scan">Contract address</span>'}</div>
    <div class="stat-row">
      <div class="stat"><small>Price</small><b>${a.live ? usd(a.priceUsd) : '—'}</b></div>
      <div class="stat"><small>Market cap</small><b>${a.live ? usd(a.mcapUsd) : '—'}</b></div>
      <div class="stat"><small>24h</small><b class="${pctCls(a.chg24)}">${a.live ? pct(a.chg24) : '—'}</b></div>
    </div>
    <div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
      <div class="ring" style="--p:${(p * 100).toFixed(1)}"><div><b>${a.live ? Math.round(p * 100) + '%' : '—'}</b><small>${a.venue === 'pumpswap' ? 'GRADUATED' : 'CURVE'}</small></div></div>
      <div class="grid" style="gap:10px;flex:1;min-width:200px">
        <b style="font-size:18px">${!a.live ? 'Pre-launch' : a.venue === 'pumpswap' ? 'Trading on PumpSwap' : 'On its pump.fun curve'}</b>
        <span class="mu" style="font-size:14px">${!a.live ? 'The contract address appears here the moment $ARK is live. Boarding opens with it.' : a.pairable ? 'Accepting new pairs: every coin launched now is priced in $ARK.' : esc(a.why || 'Not accepting pairs right now.')}</span>
        <div class="badges">${a.live ? `<span class="tag ${a.pairable ? 'ok' : 'bad'}">${a.pairable ? '● boarding open' : '● boarding paused'}</span><a class="tag" href="https://pump.fun/coin/${esc(a.ca)}" target="_blank" rel="noopener">pump.fun ↗</a><a class="tag" href="https://dexscreener.com/solana/${esc(a.ca)}" target="_blank" rel="noopener">Dexscreener ↗</a>` : ''}${cfg.x ? `<a class="tag" href="${esc(cfg.x)}" target="_blank" rel="noopener">X ↗</a>` : ''}</div>
      </div>
    </div>`;
  const ca = $('#arkCa'); if (a.live && ca) ca.onclick = () => copy(a.ca, 'Contract address copied');
}
async function load() {
  const [a, c] = await Promise.allSettled([api('ark'), api('coins')]);
  if (a.status === 'fulfilled') ARK = a.value;
  if (c.status === 'fulfilled') COINS = c.value;
  renderLive(); renderTape(); renderPairs(); renderBoard(); renderArk(); watch();
}
async function loadSlow() {
  const [p, l] = await Promise.allSettled([api('pairs'), api('live')]);
  if (p.status === 'fulfilled') PAIRS = p.value;
  if (l.status === 'fulfilled') LIVEST = l.value;
  renderTape(); renderPairs(); renderLiveState();
}
renderLiveState(); renderPairs(); renderTape();
load(); loadSlow();
setInterval(() => { if (!document.hidden) load(); }, 20000);
setInterval(() => { if (!document.hidden) loadSlow(); }, 60000);

/* ---------- buy $ARK ---------- */
function arkBuy() {
  const box = $('#arkBuy');
  box.innerHTML = `
    <span class="kick">Buy $ARK</span>
    <div class="inrow"><input id="abAmt" inputmode="decimal" value="0.5" aria-label="SOL amount"><span class="unit">SOL</span></div>
    <div class="quick">${[0.1, 0.5, 1, 5].map(v => `<button data-v="${v}">${v} SOL</button>`).join('')}</div>
    <div class="sum"><div><span>You get about</span><b id="abOut">—</b></div><div><span>Route</span><b>SOL → $ARK</b></div><div><span>Slippage</span><b>5%</b></div><div><span>ARK fee</span><b>${FEEP}%</b></div></div>
    <button class="btn gold lg block" id="abGo" ${LIVE ? '' : 'disabled'}>${LIVE ? 'Buy $ARK' : 'Opens at launch'}</button>
    <p class="mu" style="font-size:12.5px;margin:0">Straight through pump.fun's program. Simulated before you sign.</p>`;
  const inp = $('#abAmt'); let tm = 0, seq = 0;
  const quote = async () => {
    const v = parseFloat(inp.value); const my = ++seq;
    if (!LIVE || !(v > 0)) { $('#abOut').textContent = '—'; return; }
    $('#abOut').innerHTML = '<span class="skel">000000</span>';
    try { const q = await api('quote', { kind: 'trade', mint: cfg.ca, side: 'buy', via: 'SOL', amount: v, user: addr() }); if (my === seq) $('#abOut').textContent = num(q.out) + ' $ARK'; }
    catch (e) { if (my === seq) $('#abOut').textContent = '—'; }
  };
  inp.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(quote, 450); });
  $$('.quick button', box).forEach(b => b.onclick = () => { inp.value = b.dataset.v; quote(); });
  quote();
  $('#abGo').onclick = async () => {
    const v = parseFloat(inp.value); if (!(v > 0)) return toast('Enter an amount', 'bad');
    const btn = $('#abGo'); btn.disabled = true; const t0 = btn.textContent;
    try {
      await ensureWallet(); btn.textContent = 'Building…';
      const b = await api('trade', { user: addr(), mint: cfg.ca, side: 'buy', via: 'SOL', amount: v, slippage: 5 });
      btn.textContent = 'Sign in your wallet…';
      const sig = await sendSigned(await signWith(b.tx)); btn.textContent = 'Confirming…';
      await waitFor(sig); toast(`Bought about ${num(b.out)} $ARK`, 'ok'); window.open(solscan(sig), '_blank', 'noopener');
    } catch (e) { toast(cancelled(e) ? 'Cancelled in the wallet. Nothing was sent.' : e.message, 'bad'); }
    finally { btn.disabled = false; btn.textContent = t0; }
  };
}
arkBuy();

/* ---------- the gangway ---------- */
const GANG = [
  ['The right pair', "$ARK by default, or any pump.fun coin SOL can route through. Set in the create instruction.", 'ON-CHAIN · QUOTE MINT'],
  ['Fees to holders', 'Created as a pump.fun holder-reward coin. 100% of creator fees go to holders, for good.', 'ON-CHAIN · HOLDER REWARDS'],
  ['Two of every kind', 'At most two coins per ticker aboard. The third waits on the dock.', 'REGISTRY'],
  ['No impersonation', 'Major tickers, and any ticker already worth $1M+ on Solana, are refused.', 'MARKET DATA'],
  [`Dev buy ≤ ${cfg.devMaxSol || 1} SOL`, `The first buy is capped at ${cfg.devMaxSol || 1} SOL, bought right after the launch.`, 'ENFORCED · BUILDER'],
  ['Clean picture', 'Right format and size, and not a copy of a coin already aboard.', 'IMAGE HASH'],
  ['Links that work', 'X and Telegram links checked for format. The website has to load.', 'LIVE CHECK'],
  ['No promises', 'Descriptions that promise returns get flagged before launch.', 'TEXT'],
  ['Launch pace', `Up to ${cfg.perWallet || 50} launches per wallet per day.`, 'REGISTRY'],
];
$('#gang').innerHTML = GANG.map((g, i) => `<div class="card"><span class="n">${String(i + 1).padStart(2, '0')}</span><b>${esc(g[0])}</b><p>${esc(g[1])}</p><span class="chain">${g[2]}</span></div>`).join('');
watch();

/* ---------- route simulator ---------- */
const STEPS = {
  buy: [['You pay SOL', 'Any wallet, any amount.'], ['SOL buys the pair', "$ARK by default, on its own pump.fun curve or pool."], ['The pair buys the coin', "The coin's curve is priced in its pair. All three stops are one transaction: pump.fun's multi-hop swap."]],
  sell: [['You sell the coin', 'Into its curve, priced in the pair.'], ['The coin pays out the pair', 'Keep the $ARK, or keep going.'], ['The pair sells for SOL', 'Same transaction, if you want SOL back.']],
  fees: [['Every trade pays a creator fee', `${cfg.fees ? (cfg.fees.creator / 100).toFixed(2) + '% of each trade' : 'Set by pump.fun'}, in $ARK.`], ["The creator is the coin's holder pool", "Set at launch with pump.fun Holder Rewards. Nobody can change it later."], ['pump.fun pays the holders', 'Out of the pool, to the wallets holding the coin.']],
};
let mode = 'buy';
const viz = $('#routeViz'), svg = $('#routeSvg');
const POS = { sol: [0.13, 0.5], ark: [0.5, 0.26], coin: [0.87, 0.5], hold: [0.5, 0.8] };
let paths = {}, parts = [];
function layout() {
  const w = viz.clientWidth, h = viz.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  for (const [k, [x, y]] of Object.entries(POS)) { const n = viz.querySelector(`[data-n="${k}"]`); n.style.left = (x * 100) + '%'; n.style.top = (y * 100) + '%'; }
  const P = k => [POS[k][0] * w, POS[k][1] * h];
  const [sx, sy] = P('sol'), [ax, ay] = P('ark'), [cx, cy] = P('coin'), [hx, hy] = P('hold');
  const d = {
    a: `M${sx},${sy} C${sx + 60},${sy - 120} ${ax - 120},${ay} ${ax},${ay}`,
    b: `M${ax},${ay} C${ax + 120},${ay} ${cx - 60},${cy - 120} ${cx},${cy}`,
    f: `M${cx},${cy} C${cx - 20},${cy + 110} ${hx + 140},${hy} ${hx},${hy}`,
  };
  svg.innerHTML = `<defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" stop-color="rgba(243,240,232,.25)"/><stop offset="1" stop-color="rgba(216,179,106,.6)"/></linearGradient></defs>
    <path id="pa" d="${d.a}" fill="none" stroke="url(#rg)" stroke-width="1.5"/><path id="pb" d="${d.b}" fill="none" stroke="url(#rg)" stroke-width="1.5"/>
    <path id="pf" d="${d.f}" fill="none" stroke="rgba(216,179,106,.45)" stroke-width="1.5" stroke-dasharray="4 6"/><g id="dots"></g>`;
  paths = { a: $('#pa'), b: $('#pb'), f: $('#pf') };
}
function setMode(m) {
  mode = m;
  $$('#routeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#routeSteps').innerHTML = STEPS[m].map(s => `<li><div><b>${esc(s[0])}</b><span>${esc(s[1])}</span></div></li>`).join('');
  paths.f && (paths.f.style.opacity = m === 'fees' ? 1 : 0.25);
  paths.a && (paths.a.style.opacity = m === 'fees' ? 0.25 : 1); paths.b && (paths.b.style.opacity = m === 'fees' ? 0.25 : 1);
  parts = []; calc();
}
$$('#routeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.m));
layout(); setMode('buy');
new ResizeObserver(() => { layout(); setMode(mode); }).observe(viz);
let spawnT = 0, lastT = performance.now(), routeVis = false, stepOn = -1;
if ('IntersectionObserver' in window) new IntersectionObserver(es => { routeVis = es[0].isIntersecting; }).observe(viz); else routeVis = true;
function pulse(k) { const n = viz.querySelector(`[data-n="${k}"]`); if (!n) return; n.classList.remove('pulse'); void n.offsetWidth; n.classList.add('pulse'); }
function lightStep(i) { if (i === stepOn) return; stepOn = i; $$('#routeSteps li').forEach((li, j) => li.classList.toggle('on', j === i)); }
function routeTick(t) {
  requestAnimationFrame(routeTick);
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  if (!routeVis || document.hidden || !paths.a) return;
  spawnT -= dt;
  if (spawnT <= 0) {
    spawnT = mode === 'fees' ? 0.35 : 0.55;
    if (mode === 'buy') parts.push({ seq: ['a', 'b'], rev: false, i: 0, u: 0 });
    else if (mode === 'sell') parts.push({ seq: ['b', 'a'], rev: true, i: 0, u: 0 });
    else parts.push({ seq: ['f'], rev: false, i: 0, u: 0, fee: true });
  }
  let html = '';
  parts = parts.filter(p => {
    const path = paths[p.seq[p.i]], L = path.getTotalLength();
    p.u += dt * (p.fee ? 0.55 : 0.75);
    if (p.u >= 1) {
      const end = p.rev ? (p.seq[p.i] === 'b' ? 'ark' : 'sol') : (p.seq[p.i] === 'a' ? 'ark' : p.seq[p.i] === 'b' ? 'coin' : 'hold');
      if (!reduced && Math.random() < 0.35) pulse(end);
      p.i++; p.u = 0; if (p.i >= p.seq.length) return false;
    }
    const pt = path.getPointAtLength((p.rev ? 1 - p.u : p.u) * L);
    const gold = p.fee || p.seq[p.i] === 'b' || (p.rev && p.seq[p.i] === 'a');
    html += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${p.fee ? 3 : 4}" fill="${gold ? '#e9c97f' : '#f3f0e8'}" opacity=".95"/>`;
    return true;
  });
  $('#dots').innerHTML = html;
  lightStep(Math.floor((t / 1600) % 3));
}
requestAnimationFrame(routeTick);

/* calculators under the route */
let qSeq = 0, qTm = 0;
function calc() {
  const box = $('#routeCalc');
  if (mode === 'buy') {
    box.innerHTML = `<div class="grid" style="gap:14px"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="lbl">Buy a new coin with</span><b id="rcSol" style="font-size:20px">1 SOL</b></div>
      <input type="range" id="rcR" min="0" max="100" value="40" aria-label="Buy size">
      <div class="sum"><div><span>$ARK bought on the way</span><b id="rcArk">${LIVE ? '…' : 'live at launch'}</b></div><div><span>Share of a fresh coin</span><b id="rcPct">${LIVE ? '…' : '—'}</b></div></div></div>`;
    const r = $('#rcR'), val = () => +(0.1 * Math.pow(100, r.value / 100)).toFixed(2);
    const go = () => {
      r.style.setProperty('--p', r.value + '%'); $('#rcSol').textContent = val() + ' SOL';
      if (!LIVE) return; clearTimeout(qTm); qTm = setTimeout(async () => {
        const my = ++qSeq;
        try { const q = await api('quote', { kind: 'launch', sol: val() }); if (my !== qSeq) return; $('#rcArk').textContent = num(q.pairOut) + ' $ARK'; $('#rcPct').textContent = q.pct.toFixed(2) + '%'; }
        catch (e) { if (my === qSeq) { $('#rcArk').textContent = '—'; $('#rcPct').textContent = '—'; } }
      }, 350);
    };
    r.oninput = go; go();
  } else if (mode === 'fees') {
    const bps = cfg.fees ? cfg.fees.creator : 30;
    box.innerHTML = `<div class="grid" style="gap:14px"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="lbl">If a coin trades</span><b id="rcVol" style="font-size:20px">$100K/day</b></div>
      <input type="range" id="rcR" min="0" max="100" value="50" aria-label="Daily volume">
      <div class="sum"><div><span>Holders share per day</span><b id="rcAll">—</b></div><div><span>If you hold 1% of it</span><b id="rcOne">—</b></div><div><span>Creator fee</span><b>${(bps / 100).toFixed(2)}% of volume</b></div></div>
      <p class="mu" style="font-size:12.5px;margin:0">Simple arithmetic on pump.fun's live creator fee. Real volume is whatever the market does.</p></div>`;
    const r = $('#rcR');
    const go = () => { r.style.setProperty('--p', r.value + '%'); const v = 1000 * Math.pow(1000, r.value / 100); $('#rcVol').textContent = usd(v, 0) + '/day'; $('#rcAll').textContent = usd(v * bps / 1e4); $('#rcOne').textContent = usd(v * bps / 1e4 / 100); };
    r.oninput = go; go();
  } else {
    box.innerHTML = `<div class="grid" style="gap:10px"><b>Out to $ARK or all the way to SOL.</b><span class="mu" style="font-size:14px">Either way it is one transaction you sign once, built from pump.fun's own instructions and simulated before you see it.</span></div>`;
  }
}

/* ---------- the flood vs the ark ---------- */
function canvasLoop(cv, draw) {
  const ctx = cv.getContext('2d'); let w = 0, h = 0, vis = false, last = 0;
  const fit = () => { const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); w = r.width; h = r.height; cv.width = w * d; cv.height = h * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
  fit(); new ResizeObserver(fit).observe(cv);
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { vis = es[0].isIntersecting; }).observe(cv); else vis = true;
  const st = {};
  const f = t => { requestAnimationFrame(f); if (!vis || document.hidden || t - last < 33) return; const dt = Math.min(0.06, (t - last) / 1000); last = t; draw(ctx, w, h, dt, t / 1000, st); };
  requestAnimationFrame(f);
}
canvasLoop($('#floodCv'), (c, w, h, dt, t, s) => {
  if (!s.p) s.p = Array.from({ length: 60 }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: Math.random() * 8, r: 1.5 + Math.random() * 2.5, dump: 0 }));
  c.clearRect(0, 0, w, h);
  for (const p of s.p) {
    p.vx += (Math.random() - 0.5) * 60 * dt; p.vy += (Math.random() - 0.5) * 60 * dt; p.vx *= 0.98; p.vy *= 0.98;
    p.life -= dt; if (p.life < 0 && !p.dump) { p.dump = 1; p.vy = 30; }
    if (p.dump) { p.vy += 260 * dt; p.dump += dt; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.x < 0 || p.x > w) p.vx *= -1;
    if (p.y > h + 20 || p.dump > 3) Object.assign(p, { x: Math.random() * w, y: Math.random() * h * 0.6, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: 2 + Math.random() * 8, dump: 0 });
    c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fillStyle = p.dump ? 'rgba(255,122,110,.55)' : 'rgba(200,195,186,.35)'; c.fill();
  }
  c.strokeStyle = 'rgba(200,195,186,.07)';
  for (let i = 0; i < s.p.length; i += 2) for (let j = i + 1; j < s.p.length; j += 3) { const a = s.p[i], b = s.p[j], d = Math.hypot(a.x - b.x, a.y - b.y); if (d < 60) { c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); } }
});
canvasLoop($('#arkCv'), (c, w, h, dt, t, s) => {
  const cx = w * 0.72, cy = h * 0.3;
  if (!s.p) s.p = Array.from({ length: 22 }, (_, i) => ({ k: Math.random(), lane: (i % 7) / 7 }));
  c.clearRect(0, 0, w, h);
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, 90); g.addColorStop(0, 'rgba(216,179,106,.35)'); g.addColorStop(1, 'rgba(216,179,106,0)'); c.fillStyle = g; c.fillRect(cx - 90, cy - 90, 180, 180);
  for (const p of s.p) {
    p.k += dt * 0.12; if (p.k > 1) { p.k = 0; p.lane = Math.random(); }
    const sx = -20, sy = h * (0.45 + p.lane * 0.6);
    const x = sx + (cx - sx) * p.k, y = sy + (cy - sy) * Math.pow(p.k, 1.6);
    const a = Math.sin(p.k * Math.PI);
    c.strokeStyle = `rgba(216,179,106,${0.35 * a})`; c.beginPath(); c.moveTo(x - 6, y); c.lineTo(x + 6, y); c.stroke();
    c.beginPath(); c.arc(x - 6, y, 2.6, 0, 6.283); c.fillStyle = `rgba(243,240,232,${0.75 * a})`; c.fill();
    c.beginPath(); c.arc(x + 6, y, 2.6, 0, 6.283); c.fillStyle = `rgba(233,201,127,${0.9 * a})`; c.fill();
  }
});


/* ---------- launch in four steps: the visual follows the step in view ---------- */
(() => {
  const gv = $('#gv'), steps = $$('.gstep'), bar = $('#gvBar'), num = $('#gvNum'); if (!gv || !steps.length) return;
  let cur = -1;
  onFrame((y, vh) => {
    const mid = vh * 0.5; let best = 0, bd = 1e9;
    steps.forEach((st, i) => { const r = st.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - mid); if (d < bd) { bd = d; best = i; } });
    const first = steps[0].getBoundingClientRect(), last = steps[steps.length - 1].getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (mid - first.top) / Math.max(1, last.bottom - first.top)));
    bar.style.width = (p * 100).toFixed(1) + '%';
    if (best !== cur) { cur = best; gv.dataset.s = best; num.textContent = String(best + 1).padStart(2, '0'); steps.forEach((st, i) => st.classList.toggle('on', i === best)); }
  });
})();

/* ---------- timeline: the line fills as you scroll, dots light up ---------- */
(() => {
  const tl = $('#tl'), fill = $('#tlFill'), items = $$('.tl-item'); if (!tl) return;
  onFrame((y, vh) => {
    const r = tl.getBoundingClientRect(); if (r.bottom < 0 || r.top > vh) return;
    const p = Math.max(0, Math.min(1, (vh * 0.62 - r.top) / r.height));
    fill.style.height = (p * 100).toFixed(1) + '%';
    items.forEach(it => { const ir = it.getBoundingClientRect(); it.classList.toggle('on', ir.top < vh * 0.62); });
  });
})();

/* ---------- by the numbers: pump.fun's settings + ARK's rules, rolled in when they show ---------- */
function renderNums() {
  const c = cfg.curve || {}, f = cfg.fees || {};
  const tiles = [
    ['Starting virtual SOL', c.virtualSol != null ? String(c.virtualSol) : '30', 'SOL', "every new curve's starting price, set by pump.fun", false],
    ['Total supply', '1', 'B', 'tokens per coin, 6 decimals', false],
    ['Sold on the curve', c.realTokens != null ? String(Math.round(c.realTokens / 1e6)) : '793', 'M', 'tokens before a coin graduates to PumpSwap', false],
    ['Creator fee to holders', f.creator != null ? (f.creator / 100).toFixed(2) : '0.30', '%', 'of every trade, paid to holders on ARK coins', true],
    ['pump.fun protocol fee', f.protocol != null ? (f.protocol / 100).toFixed(2) : '0.95', '%', 'of every trade, to pump.fun', false],
    ['Pair depth', cfg.pump ? String(cfg.pump.maxCurveDepth) : '1', 'level', 'a pair must itself be paired to SOL', false],
    ['Dev buy cap', String(cfg.devMaxSol || 1), 'SOL', 'the most a creator can buy at launch on ARK', true],
    ['ARK fee', String(FEEP), '%', 'of buys and sells made on ARK. Launching is free.', true],
  ];
  $('#nums').innerHTML = tiles.map(([k, v, u, t, g]) => `<div class="card num${g ? ' g' : ''}"><small>${k}</small><b><span data-roll="${v}">${v}</span><i>${u}</i></b><span>${t}</span></div>`).join('');
  $('#nums').addEventListener('shown', () => $$('#nums [data-roll]').forEach(el => roll(el, el.dataset.roll, 1100)), { once: true });
  watch();
}
renderNums();

import { $, $$, esc, num, api, toast, W, addr, ensureWallet, signWith, sendSigned, waitFor, solscan, cancelled, chrome, short, img } from './core.js';
import { fx } from './fx.js';

const cfg = await chrome('launch');
fx();
const LIVE = cfg.launches === 'open';
const CAP = cfg.devCapPct || 3;
const S = { img: null, unit: 'SOL', dev: 0, quote: null, mintSecret: null, mintAddr: null, checks: null, busy: false, coins: [], hashes: null, done: null };
const cleanSym = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
const F = () => ({ name: $('#fName').value.trim(), symbol: cleanSym($('#fSym').value), description: $('#fDesc').value.trim(), twitter: $('#fX').value.trim(), telegram: $('#fTg').value.trim(), website: $('#fWeb').value.trim() });
$('#capLbl').textContent = `optional · max ${CAP}% of supply`;
if (!LIVE) { $('#lpKick').textContent = cfg.launches === 'prelaunch' ? 'Pre-launch' : 'Paused'; $('#lpSub').textContent = cfg.launches === 'prelaunch' ? 'Boarding opens the moment $ARK is live. Fill in your coin and run the gangway now: everything is ready except the launch button.' : 'Launches are paused right now.'; }
api('coins').then(d => { S.coins = d.list || []; $('#ppSeat').textContent = '#' + String(S.coins.length + 1).padStart(3, '0'); }).catch(() => { $('#ppSeat').textContent = '#001'; });

/* ---------- picture ---------- */
const readURL = f => new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(f); });
const loadImg = (src, cors) => new Promise((r, j) => { const im = new Image(); if (cors) im.crossOrigin = 'anonymous'; const t = setTimeout(() => j(new Error('timeout')), 9000); im.onload = () => { clearTimeout(t); r(im); }; im.onerror = () => { clearTimeout(t); j(new Error('load')); }; im.src = src; });
function dhash(im) {
  const c = document.createElement('canvas'); c.width = 9; c.height = 8;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, 9, 8);
  const d = x.getImageData(0, 0, 9, 8).data; let bits = '';
  for (let y = 0; y < 8; y++) for (let i = 0; i < 8; i++) { const a = (y * 9 + i) * 4, b = a + 4; bits += (d[a] * .299 + d[a + 1] * .587 + d[a + 2] * .114) > (d[b] * .299 + d[b + 1] * .587 + d[b + 2] * .114) ? '1' : '0'; }
  return bits;
}
const ham = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
async function dupOf(hash) {
  if (!S.hashes) {
    S.hashes = [];
    await Promise.all(S.coins.filter(c => c.image).slice(0, 60).map(async c => { try { S.hashes.push({ sym: c.symbol, h: dhash(await loadImg(img(c.image), true)) }); } catch (e) { } }));
  }
  const m = S.hashes.find(x => ham(x.h, hash) <= 5); return m ? m.sym : null;
}
async function onFile(f) {
  if (!f) return;
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) return toast('Use PNG, JPG, GIF or WEBP', 'bad');
  let url = await readURL(f), im = await loadImg(url), type = f.type, bytes = f.size;
  if (bytes > 4e6 || Math.max(im.naturalWidth, im.naturalHeight) > 2400) {
    const c = document.createElement('canvas'), k = 1024 / Math.max(im.naturalWidth, im.naturalHeight);
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', 0.9); type = 'image/jpeg'; bytes = Math.round((url.length - 23) * 0.75); im = await loadImg(url);
    toast('Large picture: resized to 1024 px', 'ok');
  }
  S.img = { url, type, bytes, w: im.naturalWidth, h: im.naturalHeight, hash: dhash(im), dup: null };
  $('#pv').style.backgroundImage = `url("${url}")`; $('#pv').textContent = '';
  $('#ppPic').style.backgroundImage = `url("${url}")`;
  schedule();
  S.img.dup = await dupOf(S.img.hash).catch(() => null);
  if (S.img.dup) schedule();
}
$('#file').addEventListener('change', e => onFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => onFile(e.dataTransfer.files[0]));

/* ---------- boarding pass preview ---------- */
function pass() {
  const f = F();
  $('#ppSym').textContent = '$' + (f.symbol || 'TICKER');
  $('#ppName').textContent = f.name || 'Your coin';
  $('#ppDev').textContent = S.quote && S.dev > 0 ? S.quote.pct.toFixed(2) + '%' : S.dev > 0 ? '…' : '0%';
  $('#ppCa').textContent = S.done ? short(S.done.mint, 6) : S.mintAddr ? 'CA …' + S.mintAddr.slice(-10) : 'CA ……ark';
}
const pe = $('#pass');
pe.addEventListener('pointermove', e => { const r = pe.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height; pe.style.setProperty('--ry', ((x - 0.5) * 10).toFixed(2) + 'deg'); pe.style.setProperty('--rx', ((0.5 - y) * 8).toFixed(2) + 'deg'); pe.style.setProperty('--mx', (x * 100).toFixed(0) + '%'); pe.style.setProperty('--my', (y * 100).toFixed(0) + '%'); });
pe.addEventListener('pointerleave', () => { pe.style.setProperty('--rx', '0deg'); pe.style.setProperty('--ry', '0deg'); });

/* ---------- dev buy ---------- */
$$('#devUnit button').forEach(b => b.onclick = () => { S.unit = b.dataset.u; $$('#devUnit button').forEach(x => x.classList.toggle('on', x === b)); $('#devUnitLbl').textContent = S.unit === 'SOL' ? 'SOL' : '$ARK'; $('#devNote').textContent = S.unit === 'SOL' ? 'Paying in SOL buys $ARK first (one extra signature). The first buy itself happens inside the launch transaction.' : 'Paid from the $ARK already in your wallet, inside the launch transaction.'; devQuote(); });
let dTm = 0, dSeq = 0;
function devQuote() {
  S.dev = Math.max(0, parseFloat($('#fDev').value) || 0); S.quote = null; meter(); sum(); pass();
  clearTimeout(dTm);
  if (!(S.dev > 0)) { schedule(); return; }
  if (!cfg.ca) { $('#devPct').textContent = 'Calculated when $ARK is live'; schedule(); return; }
  dTm = setTimeout(async () => {
    const my = ++dSeq;
    try { const q = await api('quote', S.unit === 'SOL' ? { kind: 'launch', sol: S.dev, user: addr() } : { kind: 'launch', ark: S.dev }); if (my !== dSeq) return; S.quote = q; }
    catch (e) { if (my === dSeq) $('#devPct').textContent = e.message; }
    meter(); sum(); pass(); schedule();
  }, 450);
}
$('#fDev').addEventListener('input', devQuote);
function meter() {
  const q = S.quote, bar = $('#devBar'), scale = CAP * 1.5;
  bar.style.setProperty('--cap', (CAP / scale * 100) + '%');
  if (!q || !(S.dev > 0)) { bar.querySelector('i').style.width = '0'; bar.classList.remove('over'); if (!(S.dev > 0)) { $('#devPct').textContent = '0% of supply'; $('#devArk').textContent = '—'; } return; }
  bar.querySelector('i').style.width = Math.min(100, q.pct / scale * 100) + '%';
  bar.classList.toggle('over', q.overCap);
  $('#devPct').textContent = `${q.pct.toFixed(2)}% of supply${q.overCap ? ` · over the ${CAP}% cap` : ''}`;
  $('#devArk').textContent = S.unit === 'SOL' ? `≈ ${num(q.ark)} $ARK` : `max ${num(q.maxArk)} $ARK`;
}
function sum() {
  const sol = 0.03 + (S.unit === 'SOL' ? S.dev : 0);
  $('#sum').innerHTML = `<div><span>Rent + network</span><b>≈ 0.03 SOL</b></div>
    <div><span>Dev buy</span><b>${S.dev > 0 ? (S.unit === 'SOL' ? `${S.dev} SOL${S.quote ? ` → ${num(S.quote.ark)} $ARK` : ''}` : `${S.dev} $ARK`) : 'none'}</b></div>
    <div><span>ARK fee</span><b>none</b></div>
    <div><span>You need</span><b>≈ ${sol.toFixed(3)} SOL${S.unit === 'ARK' && S.dev > 0 ? ` + ${S.dev} $ARK` : ''}</b></div>`;
}

/* ---------- vanity address (in this browser, in workers) ---------- */
let workers = [];
function stopVanity() { workers.forEach(w => w.terminate()); workers = []; }
function startVanity() {
  stopVanity(); S.mintSecret = null; S.mintAddr = null; pass();
  if (!window.Worker) { $('#vanityState').textContent = 'Not available in this browser. A random address will be used.'; return; }
  const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  let tried = 0; const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const w = new Worker('/js/vanity.js');
    w.onmessage = e => {
      const d = e.data;
      if (d.error) { stopVanity(); $('#vanityState').textContent = 'Not available in this browser. A random address will be used.'; return; }
      tried += d.n || 0;
      if (d.found) { stopVanity(); S.mintSecret = Uint8Array.from(d.found); S.mintAddr = d.addr; $('#vanityState').innerHTML = `Found: <span style="color:var(--ink)">${esc(d.addr.slice(0, 6))}…${esc(d.addr.slice(-10, -3))}<b class="gold">ark</b></span> after ${num(tried)} tries`; pass(); return; }
      const rate = tried / ((performance.now() - t0) / 1000);
      $('#vanityState').textContent = `Searching… ${num(tried)} tried · ${num(rate)}/s`;
    };
    w.onerror = () => { stopVanity(); $('#vanityState').textContent = 'Not available in this browser. A random address will be used.'; };
    w.postMessage({ suffix: 'ark' });
    workers.push(w);
  }
}
$('#vanity').addEventListener('change', e => { if (e.target.checked) startVanity(); else { stopVanity(); S.mintSecret = null; S.mintAddr = null; $('#vanityState').textContent = 'A random address will be used.'; pass(); } });
setTimeout(() => { if ($('#vanity').checked) startVanity(); }, 600);

/* ---------- the gangway ---------- */
const ICON = { pass: '✓', warn: '!', fail: '✕', wait: '·', run: '' };
let cTm = 0, cSeq = 0;
function schedule() { clearTimeout(cTm); paintPending(); cTm = setTimeout(runChecks, 650); }
function paintPending() { $$('#checks .ck').forEach(li => { li.className = 'ck run'; }); $('#gState').textContent = 'checking…'; }
async function runChecks() {
  const my = ++cSeq, f = F();
  const body = { ...f, symbol: $('#fSym').value, image: S.img ? { type: S.img.type, bytes: S.img.bytes, w: S.img.w, h: S.img.h, dup: S.img.dup } : null, user: addr(), devArk: S.unit === 'ARK' ? S.dev : S.quote ? S.quote.ark : 0, devSol: S.unit === 'SOL' ? S.dev : 0 };
  try {
    const r = await api('check', body); if (my !== cSeq) return;
    S.checks = r;
    $('#checks').innerHTML = r.checks.map(c => `<li class="ck ${c.status}"><span class="ic">${ICON[c.status] || ''}</span><div><b>${esc(c.label)}</b><span>${esc(c.note)}</span></div></li>`).join('');
    const fails = r.checks.filter(c => c.status === 'fail').length, warns = r.checks.filter(c => c.status === 'warn').length;
    $('#gState').textContent = fails ? `${fails} to fix` : warns ? `clear · ${warns} note${warns > 1 ? 's' : ''}` : r.ok ? 'all clear' : 'waiting';
  } catch (e) { if (my === cSeq) $('#gState').textContent = 'could not check: ' + e.message; }
  paint();
}
['fName', 'fSym', 'fDesc', 'fX', 'fTg', 'fWeb'].forEach(id => $('#' + id).addEventListener('input', () => { pass(); schedule(); }));
$('#fSym').addEventListener('blur', e => { e.target.value = cleanSym(e.target.value); pass(); });
W.change.add(() => { schedule(); paint(); });

/* ---------- launch ---------- */
function paint() {
  const b = $('#go'), f = F();
  if (S.done) { b.disabled = false; b.textContent = 'Open your coin →'; return; }
  if (!LIVE) { b.disabled = true; b.textContent = cfg.launches === 'prelaunch' ? 'Boarding opens when $ARK is live' : 'Launches are paused'; return; }
  if (S.busy) { b.disabled = true; return; }
  if (!W.acct) { b.disabled = false; b.textContent = 'Connect wallet to launch'; return; }
  const fails = S.checks ? S.checks.checks.filter(c => c.status === 'fail').length : 0;
  b.disabled = !!fails || !S.img || !f.name || f.symbol.length < 2;
  b.textContent = fails ? 'Fix the gangway first' : !S.img ? 'Add a picture' : `Launch $${f.symbol || 'TICKER'}`;
}
const logBox = $('#log');
function log(text) { logBox.hidden = false; const li = document.createElement('li'); li.className = 'on'; li.innerHTML = `<i></i><span>${esc(text)}</span><em></em>`; logBox.appendChild(li); return li; }
function ok(li, extra) { if (!li) return; li.className = 'ok'; li.querySelector('i').textContent = '✓'; if (extra) li.querySelector('em').innerHTML = extra; }
function bad(li, msg) { if (li) { li.className = 'bad'; li.querySelector('i').textContent = '✕'; } const l2 = log(msg); l2.className = 'bad'; l2.querySelector('i').textContent = '!'; }
const link = sig => `<a href="${solscan(sig)}" target="_blank" rel="noopener">tx ↗</a>`;
async function launch() {
  if (S.done) { location.href = '/coin?m=' + S.done.mint; return; }
  if (!LIVE || S.busy) return;
  if (!W.acct) { try { await ensureWallet(); } catch (e) { } paint(); return; }
  await runChecks();
  if (!S.checks || S.checks.checks.some(c => c.status === 'fail')) { toast('Fix the gangway first', 'bad'); return; }
  const f = F(), user = addr();
  S.busy = true; paint(); $('#go').textContent = 'Boarding…'; logBox.innerHTML = '';
  stopVanity();
  let st = null;
  try {
    st = log('Uploading the picture and metadata to pump.fun');
    const up = await api('ipfs', { image: S.img.url, name: f.name, symbol: f.symbol, description: f.description, twitter: f.twitter, telegram: f.telegram, website: f.website });
    ok(st);
    let devArk = 0;
    if (S.dev > 0 && S.unit === 'SOL') {
      st = log(`Building ${S.dev} SOL → $ARK for your first buy`);
      const fund = await api('build', { step: 'fund', user, sol: S.dev, slippage: 5 }); ok(st, `≈ ${num(fund.arkOut)} $ARK`);
      st = log('Sign the $ARK buy in your wallet');
      const s1 = await sendSigned(await signWith(fund.tx)); ok(st, link(s1));
      st = log('Confirming'); await waitFor(s1); ok(st);
      devArk = fund.arkMin;
    } else if (S.dev > 0) devArk = S.dev;
    const L = window.SolanaLite;
    const kp = S.mintSecret ? L.Keypair.fromSecretKey(S.mintSecret) : L.Keypair.generate();
    const mint = kp.publicKey.toBase58();
    st = log('Building the launch (simulated on-chain first)');
    const b = await api('build', { step: 'launch', user, mint, name: f.name, symbol: f.symbol, uri: up.uri, ark: devArk, slippage: 5 });
    ok(st, `${(b.units || 0).toLocaleString()} CU`);
    st = log('Sign the launch in your wallet');
    const sig = await sendSigned(await signWith(b.tx, kp)); ok(st, link(sig));
    st = log('Confirming on Solana'); await waitFor(sig); ok(st);
    if (b.followUp === 'devbuy' && b.followArk > 0) {
      st = log('Building your first buy'); const d = await api('build', { step: 'devbuy', user, mint, ark: b.followArk, slippage: 5 }); ok(st);
      st = log('Sign the first buy'); const s2 = await sendSigned(await signWith(d.tx)); ok(st, link(s2));
      st = log('Confirming'); await waitFor(s2); ok(st);
    }
    S.done = { mint, sig, symbol: f.symbol };
    success();
  } catch (e) { bad(st, cancelled(e) ? 'Cancelled in the wallet. Nothing more was sent.' : e.message); }
  finally { S.busy = false; paint(); }
}
$('#go').addEventListener('click', launch);
function success() {
  const d = S.done;
  $('#ppStamp').classList.add('on'); pass();
  const share = `https://x.com/intent/post?text=${encodeURIComponent(`Just boarded $${d.symbol} on ARK.\nPaired to $ARK. 100% of creator fees go to holders.\n\n${location.origin}/coin?m=${d.mint}`)}`;
  $('#done').hidden = false;
  $('#done').innerHTML = `<div class="grid" style="gap:10px"><b style="font-size:20px">You're aboard.</b><span class="mu">$${esc(d.symbol)} is live on pump.fun, paired to $ARK.</span>
    <div class="quick"><a class="btn sm" href="/coin?m=${esc(d.mint)}">Open coin</a><a class="btn sm" href="https://pump.fun/coin/${esc(d.mint)}" target="_blank" rel="noopener">pump.fun ↗</a><a class="btn sm" href="${share}" target="_blank" rel="noopener">Share on X</a><button class="btn sm" id="dlPass">Boarding pass ↓</button></div></div>`;
  $('#dlPass').onclick = drawPass;
  toast(`$${d.symbol} is aboard`, 'ok');
}

/* ---------- boarding pass as an image ---------- */
const A_PATH = 'M0,544 L262,0 L524,544 L412,544 L359.98,436 L164.02,436 L112,544 Z M262,232.55 L333.02,380 L190.98,380 Z';
async function drawPass() {
  const W2 = 1200, H2 = 630, c = document.createElement('canvas'); c.width = W2; c.height = H2; const x = c.getContext('2d');
  try { await Promise.all(['800 64px Inter', '500 20px JBM', '700 26px Inter'].map(f => document.fonts.load(f))); } catch (e) { }
  const g = x.createLinearGradient(0, 0, W2, H2); g.addColorStop(0, '#17161a'); g.addColorStop(0.6, '#0f0f12'); g.addColorStop(1, '#151209'); x.fillStyle = g; x.fillRect(0, 0, W2, H2);
  x.strokeStyle = 'rgba(216,179,106,.45)'; x.lineWidth = 2; x.strokeRect(24, 24, W2 - 48, H2 - 48);
  const amark = (px, py, h) => { const s = h / 544, p = new Path2D(A_PATH); for (const [side, col] of [[0, '#f3f0e8'], [1, '#d8b36a']]) { x.save(); x.translate(px, py); x.scale(s, s); x.beginPath(); x.rect(side ? 262 : -10, -10, side ? 280 : 272.6, 570); x.clip(); x.fillStyle = col; x.fill(p, 'evenodd'); x.restore(); } };
  amark(64, 60, 40); x.fillStyle = '#f3f0e8'; x.font = '800 30px Inter'; x.fillText('ARK', 118, 94);
  x.fillStyle = '#9a958d'; x.font = '500 18px JBM'; x.textAlign = 'right'; x.fillText('BOARDING PASS', W2 - 64, 90); x.textAlign = 'left';
  x.setLineDash([8, 8]); x.strokeStyle = 'rgba(216,179,106,.35)'; x.beginPath(); x.moveTo(48, 130); x.lineTo(W2 - 48, 130); x.stroke(); x.setLineDash([]);
  if (S.img) { try { const im = await loadImg(S.img.url); x.save(); const r = 28; x.beginPath(); x.roundRect(64, 170, 220, 220, r); x.clip(); const k = Math.max(220 / im.naturalWidth, 220 / im.naturalHeight); x.drawImage(im, 64 + (220 - im.naturalWidth * k) / 2, 170 + (220 - im.naturalHeight * k) / 2, im.naturalWidth * k, im.naturalHeight * k); x.restore(); } catch (e) { } }
  x.fillStyle = '#f3f0e8'; x.font = '800 84px Inter'; x.fillText('$' + S.done.symbol, 320, 262);
  x.fillStyle = '#9a958d'; x.font = '500 28px Inter'; x.fillText(F().name.slice(0, 40), 322, 312);
  const cells = [['PAIRED TO', '$ARK'], ['CREATOR FEES', '100% HOLDERS'], ['DEV BUY', S.quote && S.dev > 0 ? S.quote.pct.toFixed(2) + '%' : '0%']];
  cells.forEach(([k, v], i) => { const cx = 320 + i * 270; x.fillStyle = '#6d6963'; x.font = '500 16px JBM'; x.fillText(k, cx, 370); x.fillStyle = '#f3f0e8'; x.font = '700 28px Inter'; x.fillText(v, cx, 408); });
  x.setLineDash([8, 8]); x.beginPath(); x.moveTo(48, 470); x.lineTo(W2 - 48, 470); x.stroke(); x.setLineDash([]);
  x.fillStyle = '#9a958d'; x.font = '500 20px JBM'; x.fillText(S.done.mint, 64, 530);
  for (let i = 0; i < 70; i++) { x.fillStyle = 'rgba(217,213,204,.55)'; x.fillRect(W2 - 360 + i * 4.4, 500, (i * 7) % 3 + 1, 46); }
  x.save(); x.translate(W2 - 210, 250); x.rotate(-0.2); x.strokeStyle = '#7fe0a6'; x.lineWidth = 4; x.strokeRect(-110, -38, 220, 76); x.fillStyle = '#7fe0a6'; x.font = '800 40px JBM'; x.textAlign = 'center'; x.fillText('ABOARD', 0, 14); x.restore();
  const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `ark-${S.done.symbol.toLowerCase()}-boarding-pass.png`; a.click();
}

sum(); pass(); paint(); runChecks();

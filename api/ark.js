'use strict';
/*
 * ARK API. One serverless function behind /api/*.
 *
 * ARK never holds keys or funds. It reads the chain, uploads a coin's picture + metadata to pump.fun's
 * IPFS endpoint, builds unsigned transactions with pump.fun's official SDK (v4: pump coins as quotes,
 * holder-reward coins, multi-hop routes), simulates every one of them, and hands them to the user's
 * own wallet to sign.
 *
 * Every coin launched here is created with pump.fun's create_v2:
 *   quote mint   = $ARK          (pump.fun Custom Pairs: the coin's curve is priced in $ARK)
 *   holderReward = true          (the creator is the coin's holder-rewards PDA: 100% of creator fees go to holders)
 * and carries two extra instructions inside the same transaction:
 *   1. a Memo:  ark:v1:<TICKER>
 *   2. a 0-lamport self-transfer that lists the ARK registry address as a read-only account,
 *      so every ARK launch can be found with getSignaturesForAddress(registry).
 * The registry is a program-derived address with no private key: nobody controls it.
 *
 * Routes
 *   GET  /api/config            settings, pump.fun switches, live fee schedule
 *   GET  /api/ark               $ARK: price, market cap, curve, whether it can be paired right now
 *   GET  /api/coins             every coin launched through ARK, verified on-chain
 *   GET  /api/coin?m=           one coin: curve, checks, holder rewards, top holders, recent trades
 *   POST /api/check             the gangway: pre-launch checks for a draft coin
 *   POST /api/quote             what a trade or a dev buy would get (simulated on-chain)
 *   POST /api/ipfs              picture + metadata -> pump.fun IPFS
 *   POST /api/build             launch transactions: step = fund | launch | devbuy
 *   POST /api/trade             a buy or sell routed through $ARK (pump.fun multi_hop_swap)
 *   POST /api/send              relay a signed transaction
 *   GET  /api/status?sig=       confirmation status
 *   GET  /api/img?u=            image proxy for the coin pictures (canvas-safe)
 *   GET  /api/lab?q=            diagnostics: simulate an ARK-style launch quoted in any pump coin (nothing is sent)
 */
const { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction, Keypair } = require('@solana/web3.js');
const BN = require('bn.js');
const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
const pump = require('@pump-fun/pump-sdk');
const {
  PUMP_SDK, OnlinePumpSdk, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA,
  bondingCurvePda, holderRewardsPda, creatorVaultPda, quoteAta, isBondingCurveMigrated, canonicalPumpPoolPdaWithQuote,
  getBuyTokenAmountFromSolAmount, getBuySolAmountFromTokenAmount, bondingCurveMarketCap, pumpQuoteReserves, pumpIdl,
} = pump;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, unpackMint, unpackAccount } = require('@solana/spl-token');

/* ---------------- settings ---------------- */
const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const okKey = s => { try { return s ? new PublicKey(s).toBase58() : ''; } catch (e) { return ''; } };
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const REGISTRY = PublicKey.findProgramAddressSync([Buffer.from('ark-registry-v1')], MEMO)[0];
const ARK_CA = okKey(E('ARK_CA'));
const ARK = ARK_CA ? new PublicKey(ARK_CA) : null;
const CONFIG = {
  ca: ARK_CA,
  x: E('ARK_X'),
  telegram: E('ARK_TG'),
  // launches open once $ARK is out (ARK_CA set); ARK_LAUNCHES=paused closes them
  launches: !ARK ? 'prelaunch' : (E('ARK_LAUNCHES', 'open').toLowerCase() === 'paused' ? 'paused' : 'open'),
  devMaxSol: num(E('ARK_DEV_MAX_SOL', '1'), 0.01, 100, 1),     // max first buy, in SOL
  perWallet: Math.round(num(E('ARK_WALLET_DAILY', '50'), 1, 1000, 50)), // launches per wallet per 24h
  perTicker: 2,                                                 // two of every kind
};
const RPCS = [E('RPC_URL'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const DEC = 6;                       // every pump coin has 6 decimals
const SUPPLY_UNITS = 1e15;           // 1,000,000,000 tokens x 10^6
const CREATE_V2 = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
const CREATE_V1 = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const EVENT_IX_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]); // anchor emit_cpi tag
const EVT = Object.fromEntries((pumpIdl.events || []).map(e => [e.name, Buffer.from(e.discriminator)]));
const ERRORS = {
  6002: 'The price moved past your slippage. Try again or raise slippage.', 6003: 'The price moved past your slippage. Try again or raise slippage.',
  6042: 'The price moved past your slippage. Try again or raise slippage.', 6040: 'Not enough SOL to cover the rent for this trade.',
  6041: 'Not enough to cover the trade fees.', 6046: 'pump.fun has paused new coins right now.', 6084: 'pump.fun has holder rewards switched off right now.',
  6005: 'This coin has left the bonding curve.', 6063: '$ARK is not accepted as a pair right now.', 6105: '$ARK cannot be used as a pair (depth limit).',
  6100: '$ARK is not eligible as a pair.', 6107: '$ARK just finished its curve. Boarding reopens when it lands on PumpSwap.',
  6104: '$ARK price is out of range for a new pair.', 6102: "$ARK's pool was not found.", 6043: 'The name is too long.', 6044: 'The ticker is too long.', 6045: 'The metadata link is too long.',
};

/* ---------------- http helpers ---------------- */
function send(res, code, body, cache) {
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.status(code).send(JSON.stringify(body));
}
function http(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function readBody(req, max = 6e6) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise((r, j) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { j(http(413, 'Too large')); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
}
function timedFetch(ms) {
  return (url, opt = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
}
async function getJson(url, ms = 7000, headers = {}) {
  const r = await timedFetch(ms)(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (ark)', ...headers } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
const mem = {};
async function cached(key, ms, fn) {
  const c = mem[key];
  if (c && c.has && Date.now() - c.t < ms) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    try { const v = await fn(); mem[key] = { t: Date.now(), v, has: true }; return v; }
    catch (e) { if (c && c.has) { mem[key] = { t: c.t, v: c.v, has: true }; return c.v; } delete mem[key]; throw e; }
  })();
  mem[key] = Object.assign({}, c || {}, { p });
  return p;
}
const conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(9000) }));
async function rpc(fn) {
  let last;
  for (let round = 0; round < 2; round++) {
    for (const c of conns) { try { return await fn(c); } catch (e) { last = e; if (e && e.sdk) throw e; } }
    if (!/429|Too many|rate/i.test(String(last && last.message))) break;
    await new Promise(r => setTimeout(r, 600));
  }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).slice(0, 160));
}
// SDK calls that may throw a typed refusal (not an RPC problem): don't retry those on another node
async function sdkCall(fn) {
  let last;
  for (const c of conns) {
    try { return await fn(new OnlinePumpSdk(c), c); }
    catch (e) { last = e; if (e && /Error$/.test(e.name || '') && e.name !== 'Error' && e.name !== 'TypeError' && e.name !== 'FetchError') throw e; if (/not found|Quote|Curve|Holder|Cashback|mayhem/i.test(String(e.message))) throw e; }
  }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).slice(0, 160));
}
/* Raw JSON-RPC for transaction reads: mainnet now carries version-1 transactions, which web3.js 1.x does not parse,
 * and public nodes allow one getTransaction per batch, so these go one by one, a few at a time. */
async function rawRpc(method, params, ms = 9000) {
  let last;
  for (let round = 0; round < 2; round++) {
    for (const u of RPCS) {
      try {
        const r = await timedFetch(ms)(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (r.status === 429) throw new Error('429 Too many requests');
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      } catch (e) { last = e; }
    }
    if (!/429|Too many|rate/i.test(String(last && last.message))) break;
    await new Promise(r => setTimeout(r, 500));
  }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).slice(0, 160));
}
async function getTxs(sigs, par = 6) {
  const out = new Array(sigs.length).fill(null);
  let i = 0;
  const worker = async () => { while (i < sigs.length) { const k = i++; try { out[k] = await rawRpc('getTransaction', [sigs[k], { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], 8000); } catch (e) { } } };
  await Promise.all(Array.from({ length: Math.min(par, sigs.length) }, worker));
  return out;
}
const PUMP_ID = PUMP_PROGRAM_ID.toBase58();
function keysOf(tx) {
  const msg = tx.transaction.message;
  const st = (msg.accountKeys || msg.staticAccountKeys || []).map(k => typeof k === 'string' ? k : k.pubkey ? String(k.pubkey) : k.toBase58());
  const la = tx.meta && tx.meta.loadedAddresses ? [...(tx.meta.loadedAddresses.writable || []), ...(tx.meta.loadedAddresses.readonly || [])].map(String) : [];
  return [...st, ...la];
}
function pk(s, what = 'address') { try { return new PublicKey(String(s || '').trim()); } catch (e) { throw http(400, 'Invalid ' + what); } }
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanSym = s => clean(s, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
const toUi = (bn, d = DEC) => Number(new BN(bn).toString()) / 10 ** d;
const toUnits = (x, d = DEC) => new BN(String(Math.floor(Number(x) * 10 ** d)));
function friendly(e) {
  const n = e && e.name, m = String((e && e.message) || e);
  if (n === 'CurveDepthExceededError') return '$ARK cannot be used as a pair: it is already paired to another pump coin.';
  if (n === 'QuoteBondingCurveNotEligibleError') return '$ARK is not eligible as a pair (a mayhem-mode coin, or its own pair is not accepted).';
  if (n === 'QuoteCurveAwaitingMigrationError') return '$ARK just completed its curve. Boarding reopens when it lands on PumpSwap (usually a few minutes).';
  if (n === 'QuoteReservesOutOfRangeError') return '$ARK price is out of range for a new pair.';
  if (n === 'QuotePoolNotFoundError') return "$ARK has graduated but its PumpSwap pool was not found yet.";
  if (n === 'HolderRewardDisabledError') return 'pump.fun has holder rewards switched off right now.';
  if (n === 'UnsupportedQuoteMintError') return 'That mint is not a pump.fun coin, so it cannot be a pair.';
  return m.slice(0, 220);
}

/* ---------------- events ---------------- */
// anchor events show up as "Program data:" log lines (emit!) or as self-CPI instruction data (emit_cpi!)
function eventsOf(tx, name) {
  const d = EVT[name]; if (!d || !tx || !tx.meta) return [];
  const out = [];
  for (const l of tx.meta.logMessages || []) {
    if (!l.startsWith('Program data: ')) continue;
    let b; try { b = Buffer.from(l.slice(14), 'base64'); } catch (e) { continue; }
    if (b.length > 8 && b.subarray(0, 8).equals(d)) out.push(b.subarray(8));
  }
  if (!out.length) {
    const keys = keysOf(tx);
    for (const g of tx.meta.innerInstructions || []) for (const ix of g.instructions || []) {
      if (keys[ix.programIdIndex] !== PUMP_ID) continue;
      let b; try { b = Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data); } catch (e) { continue; }
      if (b.length > 16 && b.subarray(0, 8).equals(EVENT_IX_TAG) && b.subarray(8, 16).equals(d)) out.push(b.subarray(16));
    }
  }
  return out;
}
const safe = (fn, d = null) => { try { return fn(); } catch (e) { return d; } };

/* ---------------- pump.fun state ---------------- */
async function pumpState() {
  return cached('pumpstate', 60e3, async () => {
    const [g, f] = await rpc(c => c.getMultipleAccountsInfo([GLOBAL_PDA, PUMP_FEE_CONFIG_PDA]));
    if (!g) throw http(502, 'pump.fun Global account not found');
    const global = PUMP_SDK.decodeGlobal(g);
    const feeConfig = f ? PUMP_SDK.decodeFeeConfig(f) : null;
    return { global, feeConfig };
  });
}
function exoticFees(feeConfig) {
  if (!feeConfig) return null;
  const pick = x => x && { lp: Number(x.lpFeeBps), protocol: Number(x.protocolFeeBps), creator: Number(x.creatorFeeBps) };
  const ex = pick(feeConfig.exoticFlatFees), flat = pick(feeConfig.flatFees);
  return ex && (ex.lp + ex.protocol + ex.creator) > 0 ? ex : flat;
}
async function solUsd() {
  return cached('solusd', 60e3, async () => {
    try { const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', 5000); if (j.solana && j.solana.usd) return j.solana.usd; } catch (e) { }
    const j = await getJson('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', 6000);
    const p = (j.pairs || []).find(x => x.quoteToken && /USD/.test(x.quoteToken.symbol) && x.baseToken.symbol === 'SOL'); return p ? +p.priceUsd : null;
  });
}
async function dexFor(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const j = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + mints.slice(i, i + 30).join(','), 7000);
      for (const p of (j.pairs || [])) { if (p.chainId !== 'solana') continue; const k = p.baseToken.address, prev = out[k]; if (!prev || ((p.liquidity && p.liquidity.usd) || 0) > ((prev.liquidity && prev.liquidity.usd) || 0)) out[k] = p; }
    } catch (e) { }
  }
  return out;
}

/* ---------------- $ARK ---------------- */
// price of a SOL-quoted pump coin from its curve (or, once migrated, its PumpSwap pool)
function curvePrice(q) {
  if (!q) return null;
  let base, quote;
  if (q.pool) { base = q.pool.baseReserves; quote = q.pool.quoteReserves.add(q.pool.virtualQuoteReserves); }
  else { base = q.bondingCurve.virtualTokenReserves; quote = q.bondingCurve.virtualQuoteReserves; }
  if (base.isZero()) return null;
  return (Number(quote.toString()) / 1e9) / (Number(base.toString()) / 10 ** DEC);
}
async function arkInfo() {
  if (!ARK) return { live: false };
  return cached('ark', 15e3, async () => {
    const { global } = await pumpState();
    const [mintInfo] = await rpc(c => c.getMultipleAccountsInfo([ARK]));
    if (!mintInfo) return { live: false, ca: ARK_CA, error: '$ARK mint not found on-chain. Check ARK_CA.' };
    const prog = mintInfo.owner;
    const mint = safe(() => unpackMint(ARK, mintInfo, prog));
    let q = null, pairable = false, why = '';
    try { q = await sdkCall(s => s.fetchPumpQuote(ARK)); } catch (e) { why = friendly(e); }
    if (q) { try { pumpQuoteReserves(global, q.curve); pairable = true; } catch (e) { why = friendly(e); } }
    else if (!why) why = '$ARK is not a pump.fun coin.';
    const curve = q && q.curve.bondingCurve;
    const solQuoted = curve ? curve.quoteMint.equals(PublicKey.default) : false;
    const priceSol = q && solQuoted ? curvePrice(q.curve) : null;
    const supply = mint ? Number(mint.supply.toString()) / 10 ** mint.decimals : 1e9;
    const [sp, dex] = await Promise.all([solUsd().catch(() => null), dexFor([ARK_CA]).catch(() => ({}))]);
    const d = dex[ARK_CA];
    const irtr = Number(global.initialRealTokenReserves.toString());
    const progress = curve ? (curve.complete ? 1 : Math.max(0, Math.min(1, (irtr - Number(curve.realTokenReserves.toString())) / irtr))) : null;
    const priceUsd = d && d.priceUsd ? +d.priceUsd : priceSol != null && sp ? priceSol * sp : null;
    return {
      live: true, ca: ARK_CA, pairable, why, tokenProgram: prog.toBase58(), decimals: mint ? mint.decimals : DEC, supply,
      venue: q ? (q.curve.pool ? 'pumpswap' : 'curve') : null, depth: curve ? curve.depth : null, mayhem: curve ? !!curve.isMayhemMode : null,
      holderReward: curve ? !!curve.isHolderReward : null, progress, complete: curve ? !!curve.complete : null,
      priceSol, priceUsd, solUsd: sp, mcapUsd: d && (d.marketCap || d.fdv) ? +(d.marketCap || d.fdv) : priceUsd != null ? priceUsd * supply : null,
      vol24: d && d.volume ? +d.volume.h24 || 0 : null, chg24: d && d.priceChange ? +d.priceChange.h24 : null, chg1: d && d.priceChange ? +d.priceChange.h1 : null,
      liquidityUsd: d && d.liquidity ? +d.liquidity.usd || null : null, pair: d ? d.pairAddress : null, dex: d ? d.dexId : null,
      curveSol: curve && !q.curve.pool ? Number(curve.realQuoteReserves.toString()) / 1e9 : null,
    };
  });
}

/* ---------------- coins launched through ARK (the registry) ---------------- */
function readStr(buf, o) { const n = buf.readUInt32LE(o); return [buf.slice(o + 4, o + 4 + n).toString('utf8'), o + 4 + n]; }
function parseCreate(data) {
  const b = Buffer.from(data);
  if (b.length < 20) return null;
  const d = b.slice(0, 8);
  if (!d.equals(CREATE_V2) && !d.equals(CREATE_V1)) return null;
  let o = 8, name, symbol, uri;
  try { [name, o] = readStr(b, o); [symbol, o] = readStr(b, o); [uri, o] = readStr(b, o); } catch (e) { return null; }
  return { name: name.slice(0, 40), symbol: symbol.slice(0, 16), uri: uri.slice(0, 300) };
}
const MEMO_RE = /Memo \(len \d+\): "ark:v1:([^"]{1,24})"/;
async function launches() {
  return cached('launches', 25e3, async () => {
    const sigs = await rpc(c => c.getSignaturesForAddress(REGISTRY, { limit: 200 }));
    const good = sigs.filter(s => !s.err).slice(0, 160);
    const txs = await getTxs(good.map(s => s.signature), 8);
    const out = [];
    txs.forEach((tx, k) => {
      if (!tx || !tx.meta || tx.meta.err) return;
      const logs = tx.meta.logMessages || [];
      const m = logs.map(l => l.match(MEMO_RE)).find(Boolean); if (!m) return;
      const msg = tx.transaction.message, keys = keysOf(tx);
      let meta = null;
      for (const ix of msg.instructions || []) {
        if (keys[ix.programIdIndex] !== PUMP_ID) continue;
        const data = safe(() => bs58.decode(ix.data)); if (!data) continue;
        meta = parseCreate(data); if (meta) break;
      }
      if (!meta || !msg.header || msg.header.numRequiredSignatures < 2) return;
      const creator = keys[0], mint = keys[1];
      const ce = eventsOf(tx, 'CreateEvent').map(b => safe(() => PUMP_SDK.decodeCreateEventBc(b))).find(Boolean);
      const devUnits = (tx.meta.postTokenBalances || []).filter(b => b.mint === mint && b.owner === creator).reduce((s, b) => s + Number(b.uiTokenAmount.amount || 0), 0);
      out.push({
        sig: good[k].signature, t: (tx.blockTime || good[k].blockTime || 0) * 1000, creator, mint, ...meta,
        devPct: devUnits / SUPPLY_UNITS * 100,
        event: ce ? { quoteMint: ce.quoteMint.toBase58(), isHolderReward: !!ce.isHolderReward, depth: ce.depth } : null,
      });
    });
    return out;
  });
}
async function image(uri) {
  if (!/^https:\/\//.test(uri || '')) return null;
  return cached('img:' + uri, 24 * 3600e3, async () => {
    try { const j = await getJson(uri, 4500); return { image: typeof j.image === 'string' && /^https:\/\//.test(j.image) ? j.image : null, description: clean(j.description, 600), twitter: clean(j.twitter, 200), telegram: clean(j.telegram, 200), website: clean(j.website, 200) }; }
    catch (e) { return null; }
  });
}
function curveView(bc, quoteUsd, global) {
  if (!bc) return null;
  const migrated = isBondingCurveMigrated(bc);
  const irtr = Number(global.initialRealTokenReserves.toString());
  const mcapUnits = migrated ? null : bondingCurveMarketCap({ mintSupply: bc.tokenTotalSupply, virtualQuoteReserves: bc.virtualQuoteReserves, virtualTokenReserves: bc.virtualTokenReserves });
  const mcapArk = mcapUnits ? Number(mcapUnits.toString()) / 10 ** DEC : null;
  const priceArk = !migrated && !bc.virtualTokenReserves.isZero() ? Number(bc.virtualQuoteReserves.toString()) / Number(bc.virtualTokenReserves.toString()) : null;
  return {
    quoteMint: bc.quoteMint.toBase58(), paired: !!(ARK && bc.quoteMint.equals(ARK)), holderReward: !!bc.isHolderReward, depth: bc.depth || 0,
    mayhem: !!bc.isMayhemMode, complete: !!bc.complete, migrated,
    progress: bc.complete || migrated ? 1 : Math.max(0, Math.min(1, (irtr - Number(bc.realTokenReserves.toString())) / irtr)),
    arkLocked: Number(bc.realQuoteReserves.toString()) / 10 ** DEC, mcapArk, priceArk, mcapUsd: mcapArk != null && quoteUsd ? mcapArk * quoteUsd : null,
    feeBucket: Number((bc.creatorFee || new BN(0)).toString()) / 10 ** DEC,
  };
}
async function pairMeta(quotes) {
  // symbol + USD price for each pair mint ($ARK from its own stats, the rest from Dexscreener)
  const out = {};
  const ark = ARK ? await arkInfo().catch(() => null) : null;
  const rest = quotes.filter(q => !(ARK && q === ARK_CA));
  const dex = rest.length ? await dexFor(rest).catch(() => ({})) : {};
  for (const q of quotes) {
    if (ARK && q === ARK_CA) out[q] = { symbol: 'ARK', usd: ark && ark.priceUsd || null, main: true };
    else { const d = dex[q]; out[q] = { symbol: d && d.baseToken ? clean(d.baseToken.symbol, 16) : short4(q), usd: d ? +d.priceUsd || null : null, main: false }; }
  }
  return out;
}
const short4 = a => a.slice(0, 4) + '…';
async function coins() {
  return cached('coins', 20e3, async () => {
    const [list, ark, { global }] = await Promise.all([launches(), arkInfo().catch(() => ({ live: false })), pumpState()]);
    if (!list.length) return { list: [], ark, totals: { coins: 0, arkLocked: 0, graduated: 0, holderReward: 0, onArk: 0 } };
    const mints = list.map(c => new PublicKey(c.mint));
    const infos = [];
    for (let i = 0; i < mints.length; i += 100) infos.push(...await rpc(c => c.getMultipleAccountsInfo(mints.slice(i, i + 100).map(m => bondingCurvePda(m)))));
    const curves = infos.map(x => (x ? safe(() => PUMP_SDK.decodeBondingCurve(x)) : null));
    const quotes = [...new Set(curves.filter(Boolean).map(bc => bc.quoteMint.toBase58()))];
    // the creator's holding right now (create_v2 coins are Token-2022)
    const atas = list.map(c => getAssociatedTokenAddressSync(new PublicKey(c.mint), new PublicKey(c.creator), true, TOKEN_2022_PROGRAM_ID));
    const [meta, dex, metas, ataInfos] = await Promise.all([
      pairMeta(quotes),
      dexFor(list.map(c => c.mint)).catch(() => ({})),
      Promise.all(list.map(c => image(c.uri))),
      (async () => { const o = []; for (let i = 0; i < atas.length; i += 100) o.push(...await rpc(c => c.getMultipleAccountsInfo(atas.slice(i, i + 100))).catch(() => atas.slice(i, i + 100).map(() => null))); return o; })(),
    ]);
    const rows = list.map((c, i) => {
      const bc = curves[i]; if (!bc) return null;
      const q = bc.quoteMint.toBase58(), pm = meta[q] || { symbol: short4(q), usd: null, main: false };
      const cv = curveView(bc, pm.usd, global);
      const p = dex[c.mint], md = metas[i] || {};
      const acc = ataInfos[i] ? safe(() => unpackAccount(atas[i], ataInfos[i], TOKEN_2022_PROGRAM_ID)) : null;
      const creatorPct = acc ? Number(acc.amount) / SUPPLY_UNITS * 100 : 0;
      return {
        ...c, image: md.image || null, twitter: md.twitter || '', website: md.website || '', telegram: md.telegram || '',
        curve: cv, pair: { mint: q, symbol: pm.symbol, main: !!pm.main }, creatorPct,
        mcapUsd: p && (p.marketCap || p.fdv) ? +(p.marketCap || p.fdv) : cv ? cv.mcapUsd : null,
        priceUsd: p ? +p.priceUsd || null : cv && cv.priceArk != null && pm.usd ? cv.priceArk * pm.usd : null,
        chg24: p && p.priceChange ? +p.priceChange.h24 : null, chg1: p && p.priceChange ? +p.priceChange.h1 : null,
        vol24: p && p.volume ? +p.volume.h24 || 0 : null, dex: p ? p.dexId : null,
        checks: { paired: !!pm.main, pair: (bc.depth || 0) > 0, holders: !!bc.isHolderReward, registry: true },
      };
    }).filter(Boolean);
    const totals = {
      coins: rows.length, onArk: rows.filter(r => r.pair.main).length,
      arkLocked: rows.filter(r => r.pair.main).reduce((s, r) => s + (r.curve ? r.curve.arkLocked : 0), 0),
      graduated: rows.filter(r => r.curve && (r.curve.complete || r.curve.migrated)).length,
      holderReward: rows.filter(r => r.curve && r.curve.holderReward).length,
    };
    return { list: rows, ark, totals };
  });
}

/* ---------------- pairs: $ARK first, plus real pump.fun coins that can be a pair right now ---------------- */
const CURATED = [['FARTCOIN', '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'], ['GOAT', 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump'], ['PNUT', '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump'], ['ACT', 'GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump'], ['MOODENG', 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY'], ['FWOG', 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump'], ['MICHI', '5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp'], ['ALCH', 'HNg5PYJmtqcmzXrv6S9zP1CDKk5BgDuyFBxbvNApump'], ['SWARMS', '74SBV4zDXxTRgv1pEMoECskKBkZHc2yGPnc7GYVepump'], ['ZEREBRO', '8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn']];
const BAD_WORDS = /(nigg|n1gg|fag|retard|porn|sex|\bcum|dick|cock|puss|tits|titcoin|anal\b|rape|nazi|hitler|shit|fuck|whore|slut|nsfw|onlyfans|boob|horny|fetish|kike|cunt|penis|vagina|isis|terror|\bkill)/i;
// a pump coin can be a pair when its own curve is SOL-quoted, not mayhem, within the depth limit,
// and tradable from SOL (still on its curve, or graduated into a PumpSwap pool)
async function pairStatus(mints) {
  const { global } = await pumpState();
  const curves = mints.map(m => bondingCurvePda(m)), pools = mints.map(m => canonicalPumpPoolPdaWithQuote(m, NATIVE_MINT));
  const infos = [];
  const all = [...curves, ...pools];
  for (let i = 0; i < all.length; i += 100) infos.push(...await rpc(c => c.getMultipleAccountsInfo(all.slice(i, i + 100))));
  return mints.map((m, i) => {
    const ci = infos[i], pi = infos[mints.length + i];
    if (!ci || !ci.owner.equals(PUMP_PROGRAM_ID)) return { ok: false, why: 'Not a pump.fun coin.' };
    const bc = safe(() => PUMP_SDK.decodeBondingCurve(ci)); if (!bc) return { ok: false, why: 'Unreadable curve.' };
    if (!bc.quoteMint.equals(PublicKey.default)) return { ok: false, why: 'It is paired to another coin itself.' };
    if ((bc.depth || 0) + 1 > global.maxCurveDepth) return { ok: false, why: 'Over pump.fun\'s pair depth limit.' };
    if (bc.isMayhemMode) return { ok: false, why: 'Mayhem-mode coins cannot be a pair.' };
    if (!bc.complete) return { ok: true, venue: 'curve' };
    if (pi && pi.owner.equals(PUMP_AMM_PROGRAM_ID)) return { ok: true, venue: 'pumpswap' };
    return { ok: false, why: isBondingCurveMigrated(bc) ? 'Graduated before PumpSwap: no pump.fun pool to route through.' : 'Graduating right now.' };
  });
}
async function pairs() {
  return cached('pairs', 10 * 60e3, async () => {
    let live = [];
    // real pump.fun coins trading on PumpSwap right now (GeckoTerminal), a few pages by 24h volume
    for (const page of [1, 2, 3, 4]) {
      try {
        const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token`, 8000);
        const toks = Object.fromEntries((j.included || []).filter(x => x.type === 'token').map(x => [x.id, x.attributes]));
        for (const p of j.data || []) {
          const r = p.relationships || {}, bt = r.base_token && toks[r.base_token.data.id];
          const qt = r.quote_token && r.quote_token.data && r.quote_token.data.id || '';
          if (!bt || !/So11111111111111111111111111111111111111112$/.test(qt) || !/pump$/.test(bt.address || '')) continue;
          const a = p.attributes || {};
          live.push({ mint: bt.address, symbol: clean(bt.symbol, 16), name: clean(bt.name, 40), image: bt.image_url && /^https:/.test(bt.image_url) && !/missing/.test(bt.image_url) ? bt.image_url : null, mcapUsd: +(a.market_cap_usd || a.fdv_usd || 0) || null, chg24: a.price_change_percentage ? +a.price_change_percentage.h24 : null, vol24: a.volume_usd ? +a.volume_usd.h24 : null, src: 'live' });
        }
      } catch (e) { break; }
    }
    live = live.filter(c => c.symbol && !BAD_WORDS.test(c.symbol + ' ' + c.name) && (c.mcapUsd || 0) >= 5e4);
    const known = CURATED.map(([s, m]) => ({ mint: m, symbol: s, name: s, image: `/img/coins/${s}.png`, src: 'known' }));
    const all = [...known, ...live].filter((c, i, a) => a.findIndex(x => x.mint === c.mint) === i).slice(0, 90);
    const st = await pairStatus(all.map(c => new PublicKey(c.mint)));
    const dex = await dexFor(known.map(c => c.mint)).catch(() => ({}));
    const rows = all.map((c, i) => { const d = dex[c.mint]; return { ...c, mcapUsd: c.mcapUsd || (d && +(d.marketCap || d.fdv)) || null, chg24: c.chg24 != null ? c.chg24 : d && d.priceChange ? +d.priceChange.h24 : null, pairable: st[i].ok, venue: st[i].venue || null, why: st[i].why || '' }; });
    const ok = rows.filter(r => r.pairable).sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, 24);
    const ark = ARK ? await arkInfo().catch(() => null) : null;
    return { main: { mint: ARK_CA || null, symbol: 'ARK', live: !!(ark && ark.live), pairable: !!(ark && ark.pairable), mcapUsd: ark && ark.mcapUsd || null, chg24: ark && ark.chg24, image: '/img/icon-180.png' }, list: ok, checked: rows.length, at: Date.now() };
  });
}
async function resolvePair(pairStr) {
  const m = pairStr ? pk(pairStr, 'pair') : ARK;
  if (!m) throw http(403, 'Boarding opens when $ARK is live.');
  const [st] = await pairStatus([m]);
  if (!st.ok) throw http(400, (ARK && m.equals(ARK) ? '$ARK' : 'That coin') + ' cannot be a pair right now: ' + st.why);
  const q = await sdkCall(s => s.resolveQuoteMint(m)).catch(e => { throw http(409, friendly(e)); });
  return { mint: m, q, main: !!(ARK && m.equals(ARK)), venue: st.venue };
}
// pump.fun right now: switches, fees, and how many recent trades already run on custom pairs
async function liveState() {
  return cached('livestate', 90e3, async () => {
    const { global, feeConfig } = await pumpState();
    let scan = null;
    try {
      const r = await recentPumpCoins(100);
      const custom = r.trades.filter(t => !t.quoteMint.equals(PublicKey.default));
      const pumpQuoted = custom.filter(t => t.quoteMint.toBase58() !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      scan = { txs: r.seen, trades: r.trades.length, creates: r.creates.length, custom: custom.length, holderReward: r.trades.filter(t => t.holderRewardsBps && !t.holderRewardsBps.isZero()).length, pumpQuoted: pumpQuoted.length };
    } catch (e) { }
    return { createV2: !!global.createV2Enabled, holderRewards: !!global.isHolderRewardEnabled, maxCurveDepth: global.maxCurveDepth, fees: exoticFees(feeConfig), scan, solUsd: await solUsd().catch(() => null), at: Date.now() };
  });
}

/* ---------------- one coin ---------------- */
async function trades(mint, limit = 60) {
  return cached('trades:' + mint, 12e3, async () => {
    const curve = bondingCurvePda(new PublicKey(mint));
    const sigs = await rpc(c => c.getSignaturesForAddress(curve, { limit }));
    const good = sigs.filter(s => !s.err);
    const txs = await getTxs(good.map(s => s.signature), 8);
    const out = [];
    txs.forEach((tx, k) => {
      for (const raw of eventsOf(tx, 'TradeEvent')) {
        const ev = safe(() => PUMP_SDK.decodeTradeEventBc(raw)); if (!ev || ev.mint.toBase58() !== mint) continue;
        const quote = ev.quoteAmount && !ev.quoteAmount.isZero() ? ev.quoteAmount : ev.solAmount;
        const vq = ev.virtualQuoteReserves && !ev.virtualQuoteReserves.isZero() ? ev.virtualQuoteReserves : ev.virtualSolReserves;
        out.push({
          sig: good[k].signature, t: Number(ev.timestamp.toString()) * 1000 || (good[k].blockTime || 0) * 1000, buy: !!ev.isBuy, user: ev.user.toBase58(),
          tokens: toUi(ev.tokenAmount), ark: toUi(quote), price: Number(vq.toString()) / Math.max(1, Number(ev.virtualTokenReserves.toString())),
          rewards: toUi(ev.holderRewards && !ev.holderRewards.isZero() ? ev.holderRewards : ev.creatorFee || 0),
        });
      }
    });
    return out.sort((a, b) => b.t - a.t);
  });
}
async function rewards(mint, quoteMint, quoteProg) {
  return cached('rw:' + mint, 20e3, async () => {
    const m = new PublicKey(mint), H = holderRewardsPda(m);
    let pending = 0, paid = 0, payouts = 0, lastPaid = null;
    try {
      const vaults = await sdkCall(s => s.getCreatorVaultQuoteBalances(H, [quoteMint]));
      const v = vaults.find(x => x.mint.equals(quoteMint)); if (v) pending += toUi(v.total);
    } catch (e) { }
    try {
      const [ata] = await rpc(c => c.getMultipleAccountsInfo([quoteAta(H, quoteMint, quoteProg)]));
      if (ata) { const a = unpackAccount(quoteAta(H, quoteMint, quoteProg), ata, quoteProg); pending += Number(a.amount) / 10 ** DEC; }
    } catch (e) { }
    try {
      const sigs = await rpc(c => c.getSignaturesForAddress(H, { limit: 60 }));
      const txs = await getTxs(sigs.filter(s => !s.err).map(s => s.signature), 8);
      for (const tx of txs) for (const raw of eventsOf(tx, 'DistributeFeeToHoldersEvent')) {
        const ev = safe(() => PUMP_SDK.decodeDistributeFeeToHoldersEvent(raw)); if (!ev || ev.mint.toBase58() !== mint) continue;
        paid += toUi(ev.total); payouts++; const t = Number(ev.timestamp.toString()) * 1000; if (!lastPaid || t > lastPaid) lastPaid = t;
      }
    } catch (e) { }
    return { pda: H.toBase58(), pending, paid, payouts, lastPaid };
  });
}
async function coin(mintStr) {
  const mint = pk(mintStr, 'mint').toBase58();
  return cached('coin:' + mint, 12e3, async () => {
    const m = new PublicKey(mint);
    const [{ global }, ark] = await Promise.all([pumpState(), arkInfo().catch(() => ({ live: false }))]);
    const [bcInfo, mintInfo] = await rpc(c => c.getMultipleAccountsInfo([bondingCurvePda(m), m]));
    if (!bcInfo) throw http(404, 'No pump.fun bonding curve for this mint.');
    const bc = PUMP_SDK.decodeBondingCurve(bcInfo);
    const qStr = bc.quoteMint.toBase58();
    const pm = bc.quoteMint.equals(PublicKey.default) ? { symbol: 'SOL', usd: await solUsd().catch(() => null), main: false } : (await pairMeta([qStr]))[qStr];
    const cv = curveView(bc, pm.usd, global);
    const prog = mintInfo ? mintInfo.owner : TOKEN_2022_PROGRAM_ID;
    const mi = mintInfo ? safe(() => unpackMint(m, mintInfo, prog)) : null;
    const reg = (await launches().catch(() => [])).find(c => c.mint === mint) || null;
    // create event straight from the chain when it's not in the registry
    let base = reg;
    if (!base) {
      const sigs = await rpc(c => c.getSignaturesForAddress(bondingCurvePda(m), { limit: 1000 })).catch(() => []);
      const first = sigs.length ? sigs[sigs.length - 1] : null;
      if (first) {
        const [tx] = await getTxs([first.signature], 1);
        const ce = tx ? eventsOf(tx, 'CreateEvent').map(b => safe(() => PUMP_SDK.decodeCreateEventBc(b))).find(Boolean) : null;
        if (ce) base = { sig: first.signature, t: Number(ce.timestamp.toString()) * 1000, creator: ce.user.toBase58(), mint, name: ce.name, symbol: ce.symbol, uri: ce.uri, devPct: null };
      }
    }
    const md = base ? await image(base.uri) : null;
    const quoteMint = bc.quoteMint.equals(PublicKey.default) ? NATIVE_MINT : bc.quoteMint;
    let quoteProg = TOKEN_PROGRAM_ID;
    if (!quoteMint.equals(NATIVE_MINT)) { try { quoteProg = await sdkCall(s => s.fetchQuoteTokenProgram(quoteMint)); } catch (e) { } }
    const [tr, rw, largest, dex] = await Promise.all([
      trades(mint).catch(() => []),
      bc.isHolderReward ? rewards(mint, quoteMint, quoteProg).catch(() => null) : null,
      rpc(c => c.getTokenLargestAccounts(m)).catch(() => null),
      dexFor([mint]).catch(() => ({})),
    ]);
    // top holders: resolve token accounts to owners, mark the curve
    let holders = [];
    if (largest && largest.value) {
      const accs = largest.value.slice(0, 12);
      const infos = await rpc(c => c.getMultipleAccountsInfo(accs.map(a => new PublicKey(a.address)))).catch(() => []);
      const curveKey = bondingCurvePda(m).toBase58();
      holders = accs.map((a, i) => {
        const acc = infos[i] ? safe(() => unpackAccount(new PublicKey(a.address), infos[i], infos[i].owner)) : null;
        const owner = acc ? acc.owner.toBase58() : null;
        return { owner, pct: Number(a.amount) / SUPPLY_UNITS * 100, curve: owner === curveKey, creator: !!(base && owner === base.creator) };
      });
    }
    let creatorPct = null;
    if (base && base.creator) {
      try {
        const ata = getAssociatedTokenAddressSync(m, new PublicKey(base.creator), true, prog);
        const [ai] = await rpc(c => c.getMultipleAccountsInfo([ata]));
        creatorPct = ai ? Number(unpackAccount(ata, ai, prog).amount) / SUPPLY_UNITS * 100 : 0;
      } catch (e) { }
    }
    const p = dex[mint];
    if (!base && p && p.baseToken) base = { mint, name: clean(p.baseToken.name, 40), symbol: clean(p.baseToken.symbol, 16), uri: '', creator: null, t: p.pairCreatedAt || null, sig: null, devPct: null };
    const dexImg = p && p.info && typeof p.info.imageUrl === 'string' ? p.info.imageUrl : null;
    return {
      mint, name: base ? base.name : '', symbol: base ? base.symbol : '', uri: base ? base.uri : '', creator: base ? base.creator : null, createdAt: base ? base.t : null, createSig: base ? base.sig : null,
      viaArk: !!reg, devPct: reg ? reg.devPct : null, creatorPct, pair: { mint: bc.quoteMint.equals(PublicKey.default) ? null : qStr, symbol: pm.symbol, main: !!pm.main, sol: bc.quoteMint.equals(PublicKey.default) },
      image: (md && md.image) || dexImg, description: md && md.description, twitter: md && md.twitter, telegram: md && md.telegram, website: md && md.website,
      curve: cv, ark,
      mintAuthority: mi && mi.mintAuthority ? mi.mintAuthority.toBase58() : null, freezeAuthority: mi && mi.freezeAuthority ? mi.freezeAuthority.toBase58() : null,
      tokenProgram: prog.toBase58(),
      checks: {
        paired: !!(cv && cv.paired), pair: (bc.depth || 0) > 0, holders: !!bc.isHolderReward, registry: !!reg,
        mintAuth: mi ? !mi.mintAuthority : null, freezeAuth: mi ? !mi.freezeAuthority : null,
      },
      rewards: rw, holders, trades: tr.slice(0, 60),
      market: p ? { priceUsd: +p.priceUsd || null, mcapUsd: +(p.marketCap || p.fdv) || null, vol24: p.volume ? +p.volume.h24 || 0 : null, chg24: p.priceChange ? +p.priceChange.h24 : null, dex: p.dexId, pair: p.pairAddress } : null,
    };
  });
}

/* ---------------- quoting + routes (pump.fun multi_hop_swap) ---------------- */
// wallets with plenty of SOL, used only as the simulated signer for quotes before a wallet is connected
const QUOTERS = ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE'];
async function quoter() {
  return cached('quoter', 30 * 60e3, async () => {
    const infos = await rpc(c => c.getMultipleAccountsInfo(QUOTERS.map(k => new PublicKey(k))));
    for (let i = 0; i < QUOTERS.length; i++) { const a = infos[i]; if (a && a.owner.equals(SystemProgram.programId) && a.lamports > 500e9) return new PublicKey(QUOTERS[i]); }
    throw http(503, 'Connect a wallet to get an exact quote.');
  });
}
const SOL = NATIVE_MINT;
// SOL -> pair -> coin (or straight from the pair). A coin quoted in SOL itself (like $ARK) is one hop from SOL.
function pathFor(mint, side, via, quote) {
  if (!quote || quote.equals(PublicKey.default) || quote.equals(NATIVE_MINT)) return side === 'buy' ? [SOL, mint] : [mint, SOL];
  if (side === 'buy') return via === 'PAIR' ? [quote, mint] : [SOL, quote, mint];
  return via === 'PAIR' ? [mint, quote] : [mint, quote, SOL];
}
async function quoteOf(mint) {
  const [ci] = await rpc(c => c.getMultipleAccountsInfo([bondingCurvePda(mint)]));
  if (!ci) throw http(404, 'No pump.fun curve for this coin.');
  const bc = PUMP_SDK.decodeBondingCurve(ci);
  return bc.quoteMint;
}
async function routeOut({ path, side, amountIn, user }) {
  const hops = await sdkCall(s => s.resolveMultiHopRoute(path, side));
  let out;
  try { out = await sdkCall(s => s.simulateMultiHopSwap({ user, hops, side, amountIn })); }
  catch (e) { const m = String(e.message || e); const code = (m.match(/"Custom":(\d+)/) || [])[1]; throw http(400, ERRORS[code] || (/insufficient|0x1\b/i.test(m) ? 'Not enough balance for this trade.' : 'The route would fail: ' + m.split('\n')[0].slice(0, 160))); }
  return { hops, out };
}
async function priorityFee() {
  try {
    const r = await cached('prio', 20000, () => rpc(c => c.getRecentPrioritizationFees({ lockedWritableAccounts: [new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM')] })));
    const v = r.map(x => x.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    const p = v.length ? v[Math.floor(v.length * 0.75)] : 80000;
    return Math.max(50000, Math.min(2000000, p));
  } catch (e) { return 80000; }
}
function compile(user, ixs, cu, price, blockhash, alts = []) {
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...ixs];
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  let bytes; try { bytes = tx.serialize(); } catch (e) { bytes = null; }
  if (!bytes || bytes.length > 1232) throw http(400, 'The transaction is too large. Shorten the name or description.');
  return { tx, bytes };
}
const tryCompile = (...a) => { try { return compile(...a); } catch (e) { return null; } };
/* create + first buy on a token quote is larger than Solana's 1232-byte limit without a lookup table.
 * Lookup tables are public: we reuse the ones recent pump.fun transactions already use (or ARK_ALTS),
 * pick those covering the most of our accounts, and verify by simulation. */
async function altPool() {
  return cached('alts', 6 * 3600e3, async () => {
    let keys = E('ARK_ALTS').split(',').map(s => okKey(s.trim())).filter(Boolean);
    if (!keys.length) {
      const count = {};
      for (const prog of [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]) {
        const sigs = await rpc(c => c.getSignaturesForAddress(prog, { limit: 60 })).catch(() => []);
        const txs = await getTxs(sigs.filter(s => !s.err).map(s => s.signature), 8);
        for (const tx of txs) for (const l of ((tx && tx.transaction.message.addressTableLookups) || [])) { const k = String(l.accountKey); count[k] = (count[k] || 0) + 1; }
      }
      keys = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0]);
    }
    const out = [];
    for (const k of keys) {
      try { const r = await rpc(c => c.getAddressLookupTable(new PublicKey(k))); if (r && r.value && r.value.isActive()) out.push(r.value); } catch (e) { }
    }
    return out;
  });
}
async function pickAlts(ixs, user, price, blockhash) {
  const pool = await altPool().catch(() => []);
  if (!pool.length) return null;
  const need = new Set(); for (const ix of ixs) { need.add(ix.programId.toBase58()); for (const k of ix.keys) if (!k.isSigner) need.add(k.pubkey.toBase58()); }
  const score = t => t.state.addresses.reduce((n, a) => n + (need.has(a.toBase58()) ? 1 : 0), 0);
  const ranked = pool.map(t => [t, score(t)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  for (let n = 1; n <= Math.min(4, ranked.length); n++) {
    const alts = ranked.slice(0, n);
    if (tryCompile(user, ixs, 1_000_000, price, blockhash, alts)) return alts;
  }
  return null;
}
function explain(sim) {
  const logs = (sim && sim.logs) || [];
  const m = JSON.stringify(sim && sim.err || '').match(/"Custom":(\d+)/);
  if (m && ERRORS[m[1]]) return ERRORS[m[1]];
  const l = logs.join('\n');
  if (/insufficient lamports|insufficient funds|0x1\b/i.test(l)) return 'Not enough SOL in the wallet for this (amount + about 0.03 SOL for fees and rent).';
  if (m) return 'pump.fun rejected it (error ' + m[1] + ').';
  return 'It would fail: ' + JSON.stringify(sim && sim.err).slice(0, 160);
}
async function simulate(tx) {
  const r = await rpc(c => c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
  return r.value;
}
// simulate, then size the compute budget from what it really used
async function finalize(user, ixs, alts = [], base = 1_000_000) {
  const { blockhash, lastValidBlockHeight } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const price = await priorityFee();
  const first = compile(user, ixs, base, price, blockhash, alts);
  const sim = await simulate(first.tx);
  if (sim.err) { const e = http(400, explain(sim)); e.logs = (sim.logs || []).slice(-16); throw e; }
  const units = Math.min(1_400_000, Math.ceil((sim.unitsConsumed || 250000) * 1.2) + 25000);
  const fin = compile(user, ixs, units, price, blockhash, alts);
  return { tx: Buffer.from(fin.bytes).toString('base64'), bytes: fin.bytes.length, units, priority: price, lastValidBlockHeight, feeSol: (5000 * fin.tx.signatures.length + units * price / 1e6) / 1e9 };
}

/* ---------------- quotes ---------------- */
async function devMath(q, quoteMint, units) {
  const { global, feeConfig } = await pumpState();
  const pq = q.pumpQuote ? q.pumpQuote.curve : undefined;
  const tokens = units.isZero() ? new BN(0) : getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: units, quoteMint, pumpQuote: pq });
  return { tokens, pct: Number(tokens.toString()) / SUPPLY_UNITS * 100, seed: toUi(q.initialVirtualQuoteReserves) };
}
async function quote(b) {
  const kind = String(b.kind || 'trade');
  const user = b.user ? pk(b.user, 'wallet') : null;
  if (kind === 'launch') {
    const P = await resolvePair(b.pair);
    const sol = Math.max(0, Math.min(100, Number(b.sol) || 0));
    let pairOut = 0, tokens = 0, pct = 0;
    if (sol > 0) {
      const { out } = await routeOut({ path: [SOL, P.mint], side: 'buy', amountIn: toUnits(sol, 9), user: user || await quoter() });
      pairOut = toUi(out);
      const dm = await devMath(P.q, P.mint, out); tokens = toUi(dm.tokens); pct = dm.pct;
    }
    return { sol, pair: P.mint.toBase58(), main: P.main, pairOut, tokens, pct, maxSol: CONFIG.devMaxSol, overCap: sol > CONFIG.devMaxSol + 1e-9, depth: P.q.pumpQuote ? P.q.pumpQuote.depth : null };
  }
  if (!ARK) throw http(403, 'Trading opens when $ARK is live.');
  const mint = pk(b.mint, 'mint'), side = b.side === 'sell' ? 'sell' : 'buy', via = b.via === 'PAIR' || b.via === 'ARK' ? 'PAIR' : 'SOL';
  const amount = Math.max(0, Number(b.amount) || 0); if (!amount) throw http(400, 'Enter an amount.');
  const qm = await quoteOf(mint);
  const direct = qm.equals(PublicKey.default);
  const inDec = side === 'buy' && (via === 'SOL' || direct) ? 9 : DEC, outDec = side === 'sell' && (via === 'SOL' || direct) ? 9 : DEC;
  const path = pathFor(mint, side, via, qm);
  const signer = user || (side === 'buy' && (via === 'SOL' || direct) ? await quoter() : null);
  if (!signer) throw http(400, 'Connect a wallet to quote this.');
  const { hops, out } = await routeOut({ path, side, amountIn: toUnits(amount, inDec), user: signer });
  return { in: amount, out: toUi(out, outDec), path: path.map(p => p.toBase58()), venues: hops.map(h => h.venue), exact: !!user };
}

/* ---------------- the gangway: pre-launch checks ---------------- */
const PROMISE_RE = /\b(guarantee[ds]?|risk[- ]?free|can'?t lose|100x|1000x|10000x|financial advice|passive income|profit(s)? (daily|guaranteed))\b/i;
const BIG_TICKERS = new Set(['SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'ARK', 'PUMP', 'BONK', 'WIF', 'JUP', 'TRUMP', 'MELANIA', 'POPCAT', 'FARTCOIN', 'PENGU', 'RAY', 'JTO', 'PYTH', 'W', 'WSOL', 'MSOL', 'JITOSOL', 'BNB', 'XRP', 'DOGE', 'SHIB', 'PEPE']);
async function tickerClash(sym) {
  return cached('clash:' + sym, 10 * 60e3, async () => {
    const j = await getJson('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(sym), 6000);
    const same = (j.pairs || []).filter(p => p.chainId === 'solana' && String(p.baseToken.symbol || '').toUpperCase() === sym);
    const best = same.reduce((m, p) => Math.max(m, +(p.marketCap || p.fdv || 0)), 0);
    return { n: new Set(same.map(p => p.baseToken.address)).size, best };
  });
}
async function siteUp(url) {
  try { const r = await timedFetch(5000)(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (ark gangway)' } }); return r.status < 400; } catch (e) { return false; }
}
async function check(b) {
  const out = [];
  const add = (id, label, status, note) => out.push({ id, label, status, note });
  const name = clean(b.name, 64), symbol = cleanSym(b.symbol), rawSym = String(b.symbol || '').trim();
  const [{ global, feeConfig }, list] = await Promise.all([pumpState(), launches().catch(() => [])]);
  const fees = exoticFees(feeConfig);
  // 1. the pair: $ARK unless another pump.fun coin was picked
  const pairStr = b.pair && b.pair !== ARK_CA ? String(b.pair) : null;
  if (!ARK) add('pair', 'Pair', 'wait', 'Boarding opens when $ARK is live.');
  else {
    try {
      const m = pairStr ? pk(pairStr, 'pair') : ARK;
      const [st] = await pairStatus([m]);
      const lbl = pairStr ? 'Pair' : 'Paired to $ARK';
      if (st.ok) add('pair', lbl, 'pass', pairStr ? `Priced in ${clean(b.pairSymbol, 16) ? '$' + clean(b.pairSymbol, 16) : 'that coin'} (${st.venue === 'curve' ? 'on its curve' : 'on PumpSwap'}). $ARK stays the main pair.` : `Your coin's curve is priced in $ARK, the main pair.`);
      else add('pair', lbl, 'fail', st.why);
    } catch (e) { add('pair', 'Pair', 'fail', e.message); }
  }
  // 2. holder rewards
  add('rewards', 'Fees to holders', global.isHolderRewardEnabled ? 'pass' : 'fail', global.isHolderRewardEnabled ? `100% of creator fees go to holders${fees ? ` (${(fees.creator / 100).toFixed(2)}% of every trade)` : ''}.` : 'pump.fun has holder rewards switched off right now.');
  // 3. name + ticker
  if (!name || name.length > 32) add('name', 'Name and ticker', 'fail', !name ? 'Add a name.' : 'Name is over 32 characters.');
  else if (!symbol || symbol.length < 2) add('name', 'Name and ticker', 'fail', 'Ticker needs 2 to 10 letters or numbers.');
  else if (rawSym.replace(/^\$/, '').toUpperCase() !== symbol) add('name', 'Name and ticker', 'warn', `Ticker will be $${symbol} (letters and numbers only).`);
  else add('name', 'Name and ticker', 'pass', `${name} · $${symbol}`);
  // 4. two of every kind
  if (symbol) {
    const same = list.filter(c => cleanSym(c.symbol) === symbol);
    add('kind', 'Two of every kind', same.length >= CONFIG.perTicker ? 'fail' : 'pass', same.length >= CONFIG.perTicker ? `Two $${symbol} are already aboard. Pick another ticker.` : `${same.length} of ${CONFIG.perTicker} $${symbol} seats taken.`);
  }
  // 5. no impersonation
  if (symbol) {
    if (BIG_TICKERS.has(symbol)) add('clash', 'No impersonation', 'fail', `$${symbol} is a major token's ticker.`);
    else {
      try {
        const c = await tickerClash(symbol);
        if (c.best >= 1e6) add('clash', 'No impersonation', 'fail', `A $${symbol} worth $${fmtBig(c.best)} already trades on Solana.`);
        else if (c.n) add('clash', 'No impersonation', 'warn', `${c.n} small Solana coin${c.n > 1 ? 's' : ''} already use $${symbol}.`);
        else add('clash', 'No impersonation', 'pass', `No Solana coin trades as $${symbol}.`);
      } catch (e) { add('clash', 'No impersonation', 'warn', 'Could not reach the market data to check the ticker.'); }
    }
  }
  // 6. the picture
  const im = b.image || null;
  if (!im || !im.bytes) add('art', 'Picture', 'fail', 'Add a picture.');
  else if (!/^image\/(png|jpe?g|gif|webp)$/.test(im.type || '')) add('art', 'Picture', 'fail', 'Use PNG, JPG, GIF or WEBP.');
  else if (im.bytes > 4.2e6) add('art', 'Picture', 'fail', 'Picture is over 4 MB.');
  else if (im.dup) add('art', 'Picture', 'fail', `Same picture as $${clean(im.dup, 12)}, already aboard.`);
  else if ((im.w || 0) < 256 || (im.h || 0) < 256) add('art', 'Picture', 'warn', `Small picture (${im.w}×${im.h}). 512×512 or larger looks sharper.`);
  else if (im.w / im.h > 1.25 || im.h / im.w > 1.25) add('art', 'Picture', 'warn', 'Not square: pump.fun shows it cropped to a square.');
  else add('art', 'Picture', 'pass', `${im.w}×${im.h}, ${(im.bytes / 1024).toFixed(0)} KB, not used by any ARK coin.`);
  // 7. links
  const tw = clean(b.twitter, 200), web = clean(b.website, 200), tg = clean(b.telegram, 200);
  const probs = [];
  if (tw && !/^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}(\/status\/\d+)?\/?(\?.*)?$/.test(tw)) probs.push('X link should look like https://x.com/name');
  if (tg && !/^https:\/\/t\.me\/[A-Za-z0-9_+\/]{3,}$/.test(tg)) probs.push('Telegram link should look like https://t.me/name');
  if (web) { if (!/^https:\/\/\S+\.\S+/.test(web)) probs.push('Website must start with https://'); else if (!(await siteUp(web))) probs.push('Website did not load'); }
  if (probs.length) add('links', 'Links', 'warn', probs.join('. ') + '.');
  else add('links', 'Links', 'pass', tw || web || tg ? 'Links look right' + (web ? ' and the website loads.' : '.') : 'No links. They are optional.');
  // 8. words
  const desc = clean(b.description, 1200);
  if (desc.length > 600) add('words', 'Description', 'fail', 'Description is over 600 characters.');
  else if (PROMISE_RE.test(desc + ' ' + name)) add('words', 'Description', 'warn', 'Avoid promising returns.');
  else add('words', 'Description', 'pass', desc ? `${desc.length} characters.` : 'No description. It is optional.');
  // 9. dev buy cap, in SOL
  const devSol = Math.max(0, Number(b.devSol) || 0);
  const devLbl = `Dev buy ≤ ${CONFIG.devMaxSol} SOL`;
  if (!devSol) add('dev', devLbl, 'pass', 'No dev buy.');
  else if (devSol > CONFIG.devMaxSol + 1e-9) add('dev', devLbl, 'fail', `${devSol} SOL is over the ${CONFIG.devMaxSol} SOL cap.`);
  else add('dev', devLbl, 'pass', `${devSol} SOL, bought right after the launch through the pair.`);
  // 10. wallet
  if (!b.user) add('wallet', 'Wallet', 'wait', 'Connect a wallet.');
  else {
    const user = pk(b.user, 'wallet');
    const recent = list.filter(c => c.creator === user.toBase58() && Date.now() - c.t < 864e5).length;
    const need = 0.035 + devSol;
    let bal = null;
    try { bal = (await rpc(c => c.getBalance(user))) / 1e9; } catch (e) { }
    if (recent >= CONFIG.perWallet) add('wallet', 'Wallet', 'fail', `This wallet launched ${recent} coins in the last 24 hours (max ${CONFIG.perWallet}).`);
    else if (bal != null && bal < need) add('wallet', 'Wallet', 'fail', `Has ${bal.toFixed(3)} SOL, needs about ${need.toFixed(3)} SOL.`);
    else add('wallet', 'Wallet', 'pass', `${bal != null ? bal.toFixed(3) + ' SOL' : 'Connected'} · ${recent}/${CONFIG.perWallet} launches today.`);
  }
  // 11. pump.fun itself
  add('pump', 'pump.fun open', global.createV2Enabled ? 'pass' : 'fail', global.createV2Enabled ? 'New coins are open on pump.fun.' : 'pump.fun has paused new coins.');
  const clear = !out.some(c => c.status === 'fail') && !out.some(c => c.status === 'wait' && c.id !== 'wallet');
  return { clear, checks: out };
}
function fmtBig(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : n.toFixed(0); }
function fmtNum(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : (+n).toFixed(n < 10 ? 3 : 1); }
async function tokenBalance(owner, mint) {
  const r = await rpc(c => c.getParsedTokenAccountsByOwner(owner, { mint }));
  return r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}

/* ---------------- launch: IPFS upload ---------------- */
function gate() {
  if (CONFIG.launches === 'prelaunch') throw http(403, 'Boarding opens when $ARK is live.');
  if (CONFIG.launches !== 'open') throw http(403, 'Launches are paused right now.');
}
async function ipfs(b) {
  gate();
  const m = String(b.image || '').match(/^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw http(400, 'Add a picture (PNG, JPG, GIF or WEBP).');
  const bytes = Buffer.from(m[3], 'base64');
  if (bytes.length > 4.2e6) throw http(400, 'The picture is too large (max 4 MB).');
  const name = clean(b.name, 32), symbol = cleanSym(b.symbol);
  if (!name || !symbol) throw http(400, 'Name and ticker are required.');
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: m[1] }), 'coin.' + (m[2] === 'jpeg' ? 'jpg' : m[2]));
  fd.append('name', name); fd.append('symbol', symbol);
  fd.append('description', clean(b.description, 600));
  for (const k of ['twitter', 'telegram', 'website']) { const v = clean(b[k], 200); if (v && /^https?:\/\//.test(v)) fd.append(k, v); }
  fd.append('showName', 'true');
  const r = await timedFetch(20000)('https://pump.fun/api/ipfs', { method: 'POST', body: fd, headers: { accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/create' } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { }
  if (!r.ok || !j || !j.metadataUri) throw http(502, 'pump.fun did not accept the upload (' + r.status + '). Try again.');
  return { uri: j.metadataUri, image: j.metadata && j.metadata.image ? j.metadata.image : null };
}

/* ---------------- launch: build + simulate ---------------- */
const pairingMemo = symbol => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`ark:v1:${symbol}`, 'utf8') });
function registryTag(user) {
  const ix = SystemProgram.transfer({ fromPubkey: user, toPubkey: user, lamports: 0 });
  ix.keys.push({ pubkey: REGISTRY, isSigner: false, isWritable: false });
  return ix;
}
async function rules(user, symbol) {
  const list = await launches().catch(() => []);
  const same = list.filter(c => cleanSym(c.symbol) === symbol).length;
  if (same >= CONFIG.perTicker) throw http(400, `Two $${symbol} are already aboard. Every kind boards in pairs: pick another ticker.`);
  const recent = list.filter(c => c.creator === user.toBase58() && Date.now() - c.t < 864e5).length;
  if (recent >= CONFIG.perWallet) throw http(429, `This wallet launched ${recent} coins in the last 24 hours (max ${CONFIG.perWallet}).`);
  if (BIG_TICKERS.has(symbol)) throw http(400, `$${symbol} is a major token's ticker.`);
}
async function buildLaunch(b) {
  gate();
  const user = pk(b.user, 'wallet'), mint = pk(b.mint, 'mint');
  const name = clean(b.name, 32), symbol = cleanSym(b.symbol);
  if (!name || !symbol || symbol.length < 2) throw http(400, 'Name and a 2-10 character ticker are required.');
  const uri = clean(b.uri, 200);
  if (!/^https:\/\/\S+$/.test(uri)) throw http(400, 'Upload the picture first.');
  const dev = Math.max(0, Number(b.dev) || 0);
  if (dev > CONFIG.devMaxSol + 1e-9) throw http(400, `The dev buy cap is ${CONFIG.devMaxSol} SOL.`);
  const { global } = await pumpState();
  if (global.createV2Enabled === false) throw http(503, 'pump.fun has paused new coins right now.');
  if (!global.isHolderRewardEnabled) throw http(503, 'pump.fun has holder rewards switched off right now.');
  await rules(user, symbol);
  const P = await resolvePair(b.pair && b.pair !== ARK_CA ? b.pair : null);
  const extra = [pairingMemo(symbol), registryTag(user)];
  const base = { mint, name, symbol, uri, creator: user, user, mayhemMode: false, quoteMint: P.mint, quoteTokenProgram: P.q.quoteTokenProgram, holderReward: true, pumpQuote: P.q.pumpQuote ? P.q.pumpQuote.accounts : undefined };
  const plan = [await PUMP_SDK.createV2Instruction(base), ...extra];
  const f = await finalize(user, plan, [], 1_000_000);
  return { ...f, step: 'launch', pair: P.mint.toBase58(), main: P.main, memo: `ark:v1:${symbol}`, registry: REGISTRY.toBase58(), followUp: dev > 0 ? { via: 'SOL', amount: dev } : null };
}
// the first buy right after the create: SOL -> pair -> coin, through pump.fun's multi-hop swap
async function buildDevBuy(b) {
  gate();
  const user = pk(b.user, 'wallet'), mint = pk(b.mint, 'mint');
  const slip = Math.max(0.5, Math.min(30, Number(b.slippage) || 5)) / 100;
  const amount = Math.max(0, Math.min(CONFIG.devMaxSol, Number(b.amount) || 0));
  if (!(amount > 0)) throw http(400, 'Nothing to buy with.');
  const qm = await quoteOf(mint);
  const path = pathFor(mint, 'buy', 'SOL', qm);
  const amountIn = toUnits(amount, 9);
  const { hops, out } = await routeOut({ path, side: 'buy', amountIn, user });
  const minOut = out.mul(new BN(Math.round((1 - slip) * 10000))).div(new BN(10000));
  const ixs = await PUMP_SDK.multiHopSwapInstructions({ user, hops, side: 'buy', amountIn, minAmountOut: minOut });
  const f = await finalize(user, ixs, [], 1_400_000);
  return { ...f, step: 'devbuy', dev: { sol: amount, tokens: toUi(out), pct: Number(out.toString()) / SUPPLY_UNITS * 100 } };
}
async function build(b) {
  const step = String(b.step || 'launch');
  if (step === 'devbuy') return await buildDevBuy(b);
  return await buildLaunch(b);
}

/* ---------------- trades routed through $ARK ---------------- */
async function trade(b) {
  if (!ARK) throw http(403, 'Trading opens when $ARK is live.');
  const user = pk(b.user, 'wallet'), mint = pk(b.mint, 'mint');
  const side = b.side === 'sell' ? 'sell' : 'buy', via = b.via === 'PAIR' || b.via === 'ARK' ? 'PAIR' : 'SOL';
  const amount = Math.max(0, Number(b.amount) || 0); if (!amount) throw http(400, 'Enter an amount.');
  const slip = Math.max(0.5, Math.min(30, Number(b.slippage) || 5)) / 100;
  const qm = await quoteOf(mint), direct = qm.equals(PublicKey.default);
  const inDec = side === 'buy' && (via === 'SOL' || direct) ? 9 : DEC, outDec = side === 'sell' && (via === 'SOL' || direct) ? 9 : DEC;
  const path = pathFor(mint, side, via, qm);
  const amountIn = toUnits(amount, inDec);
  const { hops, out } = await routeOut({ path, side, amountIn, user });
  const minOut = out.mul(new BN(Math.round((1 - slip) * 10000))).div(new BN(10000));
  const ixs = await PUMP_SDK.multiHopSwapInstructions({ user, hops, side, amountIn, minAmountOut: minOut });
  const f = await finalize(user, ixs, [], 1_400_000);
  return { ...f, out: toUi(out, outDec), min: toUi(minOut, outDec), venues: hops.map(h => h.venue), path: path.map(p => p.toBase58()) };
}

/* ---------------- relay + status ---------------- */
async function relay(b) {
  const raw = Buffer.from(String(b.tx || ''), 'base64');
  if (raw.length < 64 || raw.length > 1232) throw http(400, 'Bad transaction');
  let tx; try { tx = VersionedTransaction.deserialize(raw); } catch (e) { throw http(400, 'Bad transaction'); }
  const keys = tx.message.staticAccountKeys;
  const ours = (keys.some(k => k.equals(REGISTRY)) && keys.some(k => k.equals(MEMO))) || keys.some(k => k.equals(PUMP_PROGRAM_ID) || k.equals(PUMP_AMM_PROGRAM_ID));
  if (!ours) throw http(400, 'Not an ARK transaction');
  const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }));
  delete mem.launches; delete mem.coins;
  return { sig };
}
async function status(sig) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig || '')) throw http(400, 'Bad signature');
  const r = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: true }));
  const s = r.value[0];
  return { status: s ? s.confirmationStatus : 'unknown', err: s ? s.err : null };
}

/* ---------------- image proxy (canvas-safe pictures) ---------------- */
const IMG_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(ipfs\.io|mypinata\.cloud|pinata\.cloud|cf-ipfs\.com|cloudflare-ipfs\.com|dweb\.link|nftstorage\.link|w3s\.link|arweave\.net|irys\.xyz|pump\.fun|dexscreener\.com|coingecko\.com|geckoterminal\.com|githubusercontent\.com)\//i;
async function img(req, res, u) {
  if (!IMG_HOSTS.test(u || '')) { res.status(400).send('bad host'); return; }
  const r = await timedFetch(8000)(u, { headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (ark)' } });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !/^image\//.test(type)) { res.status(502).send('no image'); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 5e6) { res.status(413).send('too large'); return; }
  res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send(buf);
}

/* ---------------- lab: prove the launch path against any pump coin (simulation only) ---------------- */
async function recentPumpCoins(limit = 120) {
  const sigs = await rpc(c => c.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit }));
  const txs = await getTxs(sigs.filter(s => !s.err).map(s => s.signature), 10);
  const creates = [], trades = [];
  let seen = 0;
  for (const tx of txs) {
    if (!tx) continue; seen++;
    for (const raw of eventsOf(tx, 'CreateEvent')) { const ev = safe(() => PUMP_SDK.decodeCreateEventBc(raw)); if (ev) creates.push(ev); }
    for (const raw of eventsOf(tx, 'TradeEvent')) { const ev = safe(() => PUMP_SDK.decodeTradeEventBc(raw)); if (ev) trades.push(ev); }
  }
  return { creates, trades, seen };
}
async function holderFromTrades(mint, prog, trades, minSol = 0.03) {
  const users = [...new Set((trades || []).filter(t => t.mint.equals(mint) && t.isBuy).map(t => t.user.toBase58()))].slice(0, 30);
  if (!users.length) return null;
  const owners = users.map(u => new PublicKey(u));
  const atas = owners.map(o => quoteAta(o, mint, prog));
  const infos = await rpc(c => c.getMultipleAccountsInfo([...owners, ...atas]));
  for (let i = 0; i < owners.length; i++) {
    const oi = infos[i], ai = infos[owners.length + i];
    if (!oi || !oi.owner.equals(SystemProgram.programId) || oi.lamports < minSol * 1e9 || !ai) continue;
    const acc = safe(() => unpackAccount(atas[i], ai, prog)); if (!acc || acc.amount === 0n) continue;
    return { owner: owners[i], amount: new BN(acc.amount.toString()) };
  }
  return null;
}
async function holderWith(mint, minSol = 0.08) {
  const largest = await rpc(c => c.getTokenLargestAccounts(mint));
  const accs = largest.value.slice(0, 15);
  const infos = await rpc(c => c.getMultipleAccountsInfo(accs.map(a => new PublicKey(a.address))));
  const owners = accs.map((a, i) => { const acc = infos[i] ? safe(() => unpackAccount(new PublicKey(a.address), infos[i], infos[i].owner)) : null; return acc ? { owner: acc.owner, amount: new BN(acc.amount.toString()) } : null; }).filter(Boolean);
  const oi = await rpc(c => c.getMultipleAccountsInfo(owners.map(o => o.owner)));
  for (let i = 0; i < owners.length; i++) if (oi[i] && oi[i].owner.equals(SystemProgram.programId) && oi[i].lamports > minSol * 1e9 && owners[i].amount.gtn(0)) return owners[i];
  return null;
}
async function lab(qs) {
  const t0 = Date.now();
  const { global, feeConfig } = await pumpState();
  const out = {
    global: { createV2Enabled: !!global.createV2Enabled, isHolderRewardEnabled: !!global.isHolderRewardEnabled, maxCurveDepth: global.maxCurveDepth, mayhemModeEnabled: !!global.mayhemModeEnabled },
    fees: exoticFees(feeConfig), registry: REGISTRY.toBase58(), ark: CONFIG.ca || null, steps: [],
  };
  const step = (k, v) => out.steps.push({ k, ...v, ms: Date.now() - t0 });
  let recent = null;
  let qMint = qs.get('q') ? pk(qs.get('q'), 'q') : null;
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  if (!qMint || qs.get('route')) {
    recent = await recentPumpCoins(Number(qs.get('scan')) || 150);
    const count = {};
    for (const t of recent.trades) if (t.quoteMint.equals(PublicKey.default) && !t.mayhemMode && t.isBuy) { const k = t.mint.toBase58(); count[k] = (count[k] || 0) + 1; }
    const ranked = Object.entries(count).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const paired = recent.trades.filter(t => !t.quoteMint.equals(PublicKey.default) && t.quoteMint.toBase58() !== USDC).map(t => ({ mint: t.mint.toBase58(), quote: t.quoteMint.toBase58(), holderReward: !t.holderRewardsBps.isZero() }));
    recent.paired = paired;
    step('scan', { seen: recent.seen, creates: recent.creates.length, trades: recent.trades.length, solCoins: ranked.length, paired: paired.slice(0, 5), createsSeen: recent.creates.slice(0, 4).map(c => ({ mint: c.mint.toBase58(), symbol: c.symbol, quote: c.quoteMint.toBase58(), depth: c.depth, holderReward: !!c.isHolderReward })) });
    if (!qMint) {
      for (const k of ranked.slice(0, 6)) { try { await sdkCall(s => s.resolveQuoteMint(new PublicKey(k))); qMint = new PublicKey(k); break; } catch (e) { step('skip', { mint: k, why: friendly(e) }); } }
      if (!qMint) { step('pick', { ok: false, note: 'no eligible SOL-quoted coin in the scan' }); return out; }
      step('pick', { ok: true, mint: qMint.toBase58() });
    }
  }
  let q;
  try { q = await sdkCall(s => s.resolveQuoteMint(qMint)); step('resolve', { ok: true, source: q.source, depth: q.pumpQuote ? q.pumpQuote.depth : 0, program: q.quoteTokenProgram.toBase58(), seed: q.initialVirtualQuoteReserves.toString() }); }
  catch (e) { step('resolve', { ok: false, error: e.name + ': ' + friendly(e) }); return out; }
  const payer = qs.get('payer') ? pk(qs.get('payer')) : await quoter();
  const mintKp = Keypair.generate();
  const base = { mint: mintKp.publicKey, name: 'ARK LAB', symbol: 'ARKLAB', uri: 'https://ipfs.io/ipfs/bafkreiark', creator: payer, user: payer, mayhemMode: false, quoteMint: qMint, quoteTokenProgram: q.quoteTokenProgram, holderReward: true, pumpQuote: q.pumpQuote ? q.pumpQuote.accounts : undefined };
  // 1. create only (holder rewards + pump-coin quote + memo + registry)
  try {
    const ixs = [await PUMP_SDK.createV2Instruction(base), pairingMemo('ARKLAB'), registryTag(payer)];
    const { blockhash } = await rpc(c => c.getLatestBlockhash('confirmed'));
    const c1 = compile(payer, ixs, 1_000_000, 100000, blockhash);
    const sim = await simulate(c1.tx);
    const ce = (sim.logs || []).filter(l => l.startsWith('Program data: ')).map(l => safe(() => Buffer.from(l.slice(14), 'base64'))).filter(b => b && b.subarray(0, 8).equals(EVT.CreateEvent)).map(b => safe(() => PUMP_SDK.decodeCreateEventBc(b.subarray(8)))).find(Boolean);
    step('create', { ok: !sim.err, err: sim.err, units: sim.unitsConsumed, bytes: c1.bytes.length, event: ce ? { quote: ce.quoteMint.toBase58(), holderReward: !!ce.isHolderReward, depth: ce.depth, creator: ce.creator.toBase58(), vq: ce.virtualQuoteReserves.toString() } : null, logs: sim.err ? (sim.logs || []).slice(-10) : undefined });
  } catch (e) { step('create', { ok: false, error: String(e.message || e).slice(0, 300) }); }
  // 2. create + first buy, paid in the quote coin, signed by a real holder of it
  try {
    const forced = qs.get('holder') ? pk(qs.get('holder'), 'holder') : null;
    let h = null;
    if (forced) { const ata = quoteAta(forced, qMint, q.quoteTokenProgram); const [ai] = await rpc(c => c.getMultipleAccountsInfo([ata])); const acc = ai ? safe(() => unpackAccount(ata, ai, q.quoteTokenProgram)) : null; if (acc && acc.amount > 0n) h = { owner: forced, amount: new BN(acc.amount.toString()) }; }
    if (!h && recent) h = await holderFromTrades(qMint, q.quoteTokenProgram, recent.trades);
    if (!h && qs.get('deep')) h = await holderWith(qMint);
    if (!h) step('createBuy', { ok: false, note: 'no holder of the quote coin with SOL found among recent buyers', buyers: recent ? recent.trades.filter(t => t.mint.equals(qMint) && t.isBuy).length : 0 });
    else {
      const qa = BN.min(h.amount.divn(50), new BN(String(5e11)));
      const dm = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: qa, quoteMint: qMint, pumpQuote: q.pumpQuote ? q.pumpQuote.curve : undefined });
      const b2 = { ...base, creator: h.owner, user: h.owner };
      const cb = [...await PUMP_SDK.createV2AndBuyV2Instructions({ global, ...b2, amount: dm, quoteAmount: qa, slippage: 5 }), pairingMemo('ARKLAB'), registryTag(h.owner)];
      const { blockhash } = await rpc(c => c.getLatestBlockhash('confirmed'));
      let c2 = tryCompile(h.owner, cb, 1_000_000, 100000, blockhash), alts = [];
      if (!c2) { alts = (await pickAlts(cb, h.owner, 100000, blockhash)) || []; c2 = tryCompile(h.owner, cb, 1_000_000, 100000, blockhash, alts); }
      if (!c2) step('createBuy', { ok: false, note: 'does not fit in one transaction even with public lookup tables', alts: alts.length });
      else {
        const sim = await simulate(c2.tx);
        step('createBuy', { ok: !sim.err, err: sim.err, units: sim.unitsConsumed, bytes: c2.bytes.length, alts: alts.map(a => a.key.toBase58()), holder: h.owner.toBase58(), quoteIn: toUi(qa), tokensOut: toUi(dm), pct: Number(dm.toString()) / SUPPLY_UNITS * 100, logs: sim.err ? (sim.logs || []).slice(-12) : undefined });
      }
    }
  } catch (e) { step('createBuy', { ok: false, error: String(e.message || e).slice(0, 300) }); }
  // 3. SOL -> quote coin through multi_hop_swap (how a launcher funds a dev buy)
  try {
    const { hops, out: o } = await routeOut({ path: [SOL, qMint], side: 'buy', amountIn: toUnits(Number(qs.get('sol')) || 0.05, 9), user: await quoter() });
    step('fund', { ok: true, venues: hops.map(h => h.venue), out: toUi(o) });
  } catch (e) { step('fund', { ok: false, error: String(e.message || e).slice(0, 300) }); }
  // 4. SOL -> quote -> a coin already paired to it (if the scan saw one), the route every ARK buy takes
  try {
    let paired = null;
    const quotes = [...new Set(((recent && recent.paired) || []).map(p => p.quote))].slice(0, 8);
    if (quotes.length) {
      const infos = await rpc(c => c.getMultipleAccountsInfo(quotes.map(qq => bondingCurvePda(new PublicKey(qq)))));
      const okq = quotes.filter((qq, i) => infos[i] && infos[i].owner.equals(PUMP_PROGRAM_ID));
      paired = recent.paired.find(p => okq.includes(p.quote)) || null;
      step('pairedScan', { quotes: quotes.length, pumpQuotes: okq });
    }
    if (paired) {
      const { hops, out: o } = await routeOut({ path: [SOL, new PublicKey(paired.quote), new PublicKey(paired.mint)], side: 'buy', amountIn: toUnits(0.05, 9), user: await quoter() });
      step('route2', { ok: true, coin: paired.mint, quote: paired.quote, venues: hops.map(h => h.venue), out: toUi(o) });
    } else step('route2', { ok: false, note: 'no coin quoted in a pump coin in this scan' });
  } catch (e) { step('route2', { ok: false, error: String(e.message || e).slice(0, 300) }); }
  return out;
}

/* ---------------- router ---------------- */
module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = String(url.searchParams.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
    const q = url.searchParams;
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (path === 'config') {
      const { global, feeConfig } = await pumpState().catch(() => ({}));
      return send(res, 200, {
        ok: true, ca: CONFIG.ca, x: CONFIG.x, telegram: CONFIG.telegram, launches: CONFIG.launches, registry: REGISTRY.toBase58(), memo: MEMO.toBase58(),
        devMaxSol: CONFIG.devMaxSol, perWallet: CONFIG.perWallet, perTicker: CONFIG.perTicker,
        pump: global ? { createV2: !!global.createV2Enabled, holderRewards: !!global.isHolderRewardEnabled, maxCurveDepth: global.maxCurveDepth } : null,
        fees: exoticFees(feeConfig), supply: 1e9,
      }, 'public, s-maxage=30, stale-while-revalidate=120');
    }
    if (path === 'ark') return send(res, 200, { ok: true, ...(await arkInfo()) }, 'public, s-maxage=10, stale-while-revalidate=30');
    if (path === 'pairs') return send(res, 200, { ok: true, ...(await pairs()) }, 'public, s-maxage=300, stale-while-revalidate=900');
    if (path === 'pair') {
      const m = pk(q.get('m'), 'mint');
      const [[st], dex] = await Promise.all([pairStatus([m]), dexFor([m.toBase58()]).catch(() => ({}))]);
      const d = dex[m.toBase58()];
      return send(res, 200, { ok: true, mint: m.toBase58(), pairable: st.ok, why: st.why || '', venue: st.venue || null, main: !!(ARK && m.equals(ARK)), symbol: d && d.baseToken ? clean(d.baseToken.symbol, 16) : '', name: d && d.baseToken ? clean(d.baseToken.name, 40) : '', image: d && d.info && d.info.imageUrl || null, mcapUsd: d ? +(d.marketCap || d.fdv) || null : null }, 'public, s-maxage=60');
    }
    if (path === 'live') return send(res, 200, { ok: true, ...(await liveState()) }, 'public, s-maxage=60, stale-while-revalidate=120');
    if (path === 'coins') return send(res, 200, { ok: true, ...(await coins()) }, 'public, s-maxage=15, stale-while-revalidate=45');
    if (path === 'coin') return send(res, 200, { ok: true, ...(await coin(q.get('m'))) }, 'public, s-maxage=10, stale-while-revalidate=30');
    if (path === 'status') return send(res, 200, { ok: true, ...(await status(q.get('sig'))) });
    if (path === 'img') return await img(req, res, q.get('u'));
    if (path === 'lab') return send(res, 200, { ok: true, ...(await lab(q)) });
    if (path === 'bal') {
      const u = pk(q.get('u'), 'wallet'), m = q.get('m') ? pk(q.get('m'), 'mint') : null;
      const [sol, token, ark] = await Promise.all([rpc(c => c.getBalance(u)).then(x => x / 1e9).catch(() => null), m ? tokenBalance(u, m).catch(() => null) : null, ARK ? tokenBalance(u, ARK).catch(() => null) : null]);
      return send(res, 200, { ok: true, sol, token, ark });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (path === 'check') return send(res, 200, { ok: true, ...(await check(b)) });
      if (path === 'quote') return send(res, 200, { ok: true, ...(await quote(b)) });
      if (path === 'ipfs') return send(res, 200, { ok: true, ...(await ipfs(b)) });
      if (path === 'build') return send(res, 200, { ok: true, ...(await build(b)) });
      if (path === 'trade') return send(res, 200, { ok: true, ...(await trade(b)) });
      if (path === 'send') return send(res, 200, { ok: true, ...(await relay(b)) });
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    return send(res, code, { ok: false, error: friendly(e), logs: e.logs });
  }
};
module.exports._test = { parseCreate, MEMO_RE, REGISTRY, pairingMemo, registryTag, compile, tryCompile, CONFIG, eventsOf, pathFor, cleanSym };

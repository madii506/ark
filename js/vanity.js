/* Worker: search for a mint keypair whose address ends with a suffix. The key never leaves this browser. */
let ok = true;
try { importScripts('/vendor/solana-lite.js'); } catch (e) { ok = false; }
onmessage = e => {
  const suffix = String(e.data && e.data.suffix || 'ark');
  if (!ok || !self.SolanaLite) { postMessage({ error: 'unavailable' }); return; }
  const K = self.SolanaLite.Keypair;
  const loop = () => {
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 120) {
      for (let i = 0; i < 40; i++) {
        const kp = K.generate(); n++;
        const a = kp.publicKey.toBase58();
        if (a.endsWith(suffix)) { postMessage({ n, found: Array.from(kp.secretKey), addr: a }); return; }
      }
    }
    postMessage({ n });
    setTimeout(loop, 0);
  };
  loop();
};

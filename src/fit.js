// Estimates whether a model fits into this PC's VRAM: weights + KV cache for the chosen context + runtime overhead.
const GIB = 1024 ** 3;
const VRAM_RESERVE = 0.6 * GIB; // Windows desktop and other apps keep this much VRAM busy

// Bytes the KV cache needs per token of context (K and V, f16).
function kvPerToken({ layers, kvHeads, headDim, params }) {
  if (layers && kvHeads && headDim) return layers * kvHeads * headDim * 2 * 2;
  // Typical GQA models: ~32 KB/token at 1B, ~130 KB at 8B, ~330 KB at 70B
  const billions = Math.max(params || 0, 1e8) / 1e9;
  return 40 * 1024 * Math.sqrt(billions);
}

// "8.2B" / "135M" / "254K" -> number of parameters
function parseParamSize(text) {
  const m = /([\d.]+)\s*([KMBT])/i.exec(text || '');
  if (!m) return null;
  return Math.round(Number(m[1]) * { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()]);
}

function estimate({ fileBytes, params, bits, ctx = 4096, arch = {}, vram = 0, ram = 0 }) {
  if (!params && bits) params = (fileBytes * 8) / bits;
  const kv = kvPerToken({ ...arch, params }) * ctx;
  const overhead = 0.4 * GIB + fileBytes * 0.05;
  const need = fileBytes + kv + overhead;
  const usable = Math.max(0, vram - VRAM_RESERVE);
  let level;
  let gpuShare = 0;
  if (vram && need <= usable) {
    level = 'gpu';
    gpuShare = 1;
  } else if (need <= usable + ram * 0.5) {
    level = vram ? 'mixed' : 'cpu';
    gpuShare = vram ? usable / need : 0;
  } else {
    level = 'no';
  }
  return { level, need, kv, usable, gpuShare, label: LABELS[level] };
}

const LABELS = {
  gpu: 'Passt komplett auf die GPU',
  mixed: 'Teilweise CPU – langsamer',
  cpu: 'Läuft nur auf der CPU – langsam',
  no: 'Zu gross für diesen PC',
};

const HEADROOM = 0.4 * GIB; // recommended variants keep some VRAM free so a longer chat does not spill to the CPU

// Best variant for this PC: highest quality that runs fully on the GPU (F16/BF16/F32 only as last resort).
function recommend(variants, opts) {
  const usable = variants.filter((v) => v.bits && !v.split);
  const scored = usable.map((v) => ({ v, fit: estimate({ ...opts, fileBytes: v.size, bits: v.bits }) }));
  const quantised = (s) => s.v.bits < 16;
  const pick = (list) => list.sort((a, b) => b.v.bits - a.v.bits || a.v.size - b.v.size)[0];
  const onGpu = scored.filter((s) => s.fit.level === 'gpu' && s.fit.need <= s.fit.usable - HEADROOM);
  const best = pick(onGpu.filter(quantised)) || pick(onGpu)
    || scored.filter((s) => s.fit.level !== 'no' && s.v.bits >= 4 && quantised(s)).sort((a, b) => a.v.size - b.v.size)[0]
    || scored.filter((s) => s.fit.level !== 'no').sort((a, b) => a.v.size - b.v.size)[0];
  return best ? best.v.path : null;
}

module.exports = { estimate, recommend, kvPerToken, parseParamSize, GIB };

// Reads quantisation names out of GGUF file names and groups a repo's files into downloadable variants.

// Approximate bits per weight of each llama.cpp quantisation, used for sorting and size estimates.
const BITS = {
  F32: 32, F16: 16, BF16: 16,
  Q8_0: 8.5, Q8_K_XL: 9, Q6_K: 6.56, Q6_K_XL: 7, Q6_K_L: 6.8,
  Q5_K_XL: 6, Q5_K_L: 5.9, Q5_K_M: 5.69, Q5_K_S: 5.54, Q5_1: 6, Q5_0: 5.5,
  Q4_K_XL: 5, Q4_K_L: 5.1, Q4_K_M: 4.85, Q4_K_S: 4.58, Q4_1: 5, Q4_0: 4.55, IQ4_NL: 4.5, IQ4_XS: 4.25, MXFP4: 4.25, MXFP4_MOE: 4.25,
  Q3_K_XL: 4.1, Q3_K_L: 4.27, Q3_K_M: 3.91, Q3_K_S: 3.5, IQ3_M: 3.66, IQ3_S: 3.44, IQ3_XS: 3.3, IQ3_XXS: 3.06,
  Q2_K_XL: 3.1, Q2_K_L: 3.2, Q2_K: 3.0, IQ2_M: 2.7, IQ2_S: 2.5, IQ2_XS: 2.31, IQ2_XXS: 2.06,
  IQ1_M: 1.75, IQ1_S: 1.56, TQ2_0: 2.06, TQ1_0: 1.69,
};

const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?|TQ\d_\d))(?=$|[-_.])/gi;
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

function baseName(path) {
  return path.split('/').pop();
}

// "Qwen3-4B-UD-Q4_K_XL.gguf" -> "UD-Q4_K_XL", "model-q4_k_m-00001-of-00002.gguf" -> "Q4_K_M"
function parseQuant(path) {
  let name = baseName(path).replace(SPLIT_RE, '').replace(/\.gguf$/i, '');
  let last = null;
  for (const m of name.matchAll(QUANT_RE)) last = m[1];
  if (!last) {
    // Quant folders like "Q4_K_M/model-00001-of-00003.gguf"
    const dir = path.split('/').slice(-2, -1)[0] || '';
    for (const m of ('-' + dir).matchAll(QUANT_RE)) last = m[1];
  }
  return last ? last.toUpperCase() : null;
}

function bitsOf(quant) {
  if (!quant) return null;
  const q = quant.replace(/^UD-/, '');
  if (BITS[q]) return BITS[q];
  const m = /^I?Q(\d)/.exec(q);
  return m ? Number(m[1]) + 0.5 : null;
}

function qualityLabel(bits) {
  if (!bits) return 'Unbekannt';
  if (bits >= 8) return 'Fast verlustfrei';
  if (bits >= 6) return 'Sehr gut';
  if (bits >= 5) return 'Gut';
  if (bits >= 4) return 'Standard';
  if (bits >= 3) return 'Spürbar schwächer';
  return 'Stark komprimiert';
}

function isModelFile(path) {
  const n = baseName(path).toLowerCase();
  return n.endsWith('.gguf') && !n.includes('mmproj') && !n.includes('imatrix');
}

// Turns a repo file list into one entry per variant; split files (-00001-of-0000N) become a single entry.
function groupVariants(files) {
  const groups = new Map();
  for (const f of files) {
    if (f.type !== 'file' || !isModelFile(f.path)) continue;
    const split = SPLIT_RE.exec(f.path);
    const key = split ? f.path.replace(SPLIT_RE, '') : f.path;
    const g = groups.get(key) || { path: f.path, size: 0, parts: 0, split: !!split };
    g.size += f.size || (f.lfs && f.lfs.size) || 0;
    g.parts += 1;
    if (split && split[1] === '00001') g.path = f.path;
    groups.set(key, g);
  }
  const variants = [...groups.values()].map((g) => {
    const quant = parseQuant(g.path);
    const bits = bitsOf(quant);
    return { ...g, file: baseName(g.path), quant, bits, quality: qualityLabel(bits) };
  });
  // Ollama's Hugging Face registry accepts a quant name as tag; fall back to the file name when it is ambiguous.
  const count = new Map();
  for (const v of variants) if (v.quant) count.set(v.quant, (count.get(v.quant) || 0) + 1);
  for (const v of variants) {
    v.tag = v.quant && count.get(v.quant) === 1 ? v.quant : v.file;
  }
  variants.sort((a, b) => (a.bits || 99) - (b.bits || 99) || a.size - b.size);
  return variants;
}

module.exports = { parseQuant, bitsOf, qualityLabel, groupVariants, isModelFile };

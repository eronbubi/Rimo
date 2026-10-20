const test = require('node:test');
const assert = require('node:assert');
const { estimate, recommend, parseParamSize, GIB } = require('../src/fit');

const pc = { vram: 8 * GIB, ram: 16 * GIB, ctx: 4096 };
// Qwen3-8B: 36 layers, 8 KV heads, head dim 128
const qwenArch = { layers: 36, kvHeads: 8, headDim: 128 };

test('8B Q4_K_M fits on 8 GB, Q8_0 spills to CPU, 70B does not fit', () => {
  assert.strictEqual(estimate({ ...pc, fileBytes: 5.03e9, params: 8.2e9, arch: qwenArch }).level, 'gpu');
  assert.strictEqual(estimate({ ...pc, fileBytes: 8.7e9, params: 8.2e9, arch: qwenArch }).level, 'mixed');
  assert.strictEqual(estimate({ ...pc, fileBytes: 42e9, params: 70e9 }).level, 'no');
  assert.strictEqual(estimate({ ...pc, vram: 0, fileBytes: 2e9, params: 3e9 }).level, 'cpu');
});

test('KV cache grows with context', () => {
  const a = estimate({ ...pc, fileBytes: 5e9, arch: qwenArch, ctx: 4096 });
  const b = estimate({ ...pc, fileBytes: 5e9, arch: qwenArch, ctx: 32768 });
  assert.strictEqual(Math.round(a.kv / 1024 ** 2), 576);
  assert.ok(b.kv === a.kv * 8);
});

test('recommends best quant that fits on GPU', () => {
  const v = [
    { path: 'q2', bits: 3, size: 3.2e9 }, { path: 'q4', bits: 4.85, size: 5.0e9 },
    { path: 'q6', bits: 6.56, size: 6.7e9 }, { path: 'q8', bits: 8.5, size: 8.7e9 }, { path: 'f16', bits: 16, size: 16.4e9 },
  ];
  assert.strictEqual(recommend(v, { ...pc, params: 8.2e9 }), 'q4');
  assert.strictEqual(recommend(v, { ...pc, vram: 24 * GIB, params: 8.2e9 }), 'q8');
});

test('parses Ollama parameter sizes', () => {
  assert.strictEqual(parseParamSize('8.2B'), 8.2e9);
  assert.strictEqual(parseParamSize('135M'), 135e6);
  assert.strictEqual(parseParamSize(''), null);
});

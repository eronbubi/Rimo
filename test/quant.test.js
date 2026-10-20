const test = require('node:test');
const assert = require('node:assert');
const { parseQuant, groupVariants, bitsOf } = require('../src/quant');

test('parses quant names from file names', () => {
  assert.strictEqual(parseQuant('Llama-3.2-3B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
  assert.strictEqual(parseQuant('Qwen3-4B-UD-Q4_K_XL.gguf'), 'UD-Q4_K_XL');
  assert.strictEqual(parseQuant('model-iq3_xxs.gguf'), 'IQ3_XXS');
  assert.strictEqual(parseQuant('Qwen3-4B-BF16.gguf'), 'BF16');
  assert.strictEqual(parseQuant('big-Q8_0-00001-of-00003.gguf'), 'Q8_0');
  assert.strictEqual(parseQuant('Q4_K_M/big-00001-of-00003.gguf'), 'Q4_K_M');
  assert.strictEqual(parseQuant('Qwen3-8B.gguf'), null);
});

test('groups split files, skips mmproj and picks tags', () => {
  const f = (path, size) => ({ type: 'file', path, size });
  const v = groupVariants([
    f('a-Q4_K_M.gguf', 100), f('a-Q8_0.gguf', 200), f('mmproj-a-f16.gguf', 5), f('README.md', 1),
    f('b-Q2_K-00001-of-00002.gguf', 50), f('b-Q2_K-00002-of-00002.gguf', 50),
    f('x/a-Q4_K_M.gguf', 100),
  ]);
  assert.deepStrictEqual(v.map((x) => x.quant), ['Q2_K', 'Q4_K_M', 'Q4_K_M', 'Q8_0']);
  const split = v.find((x) => x.split);
  assert.strictEqual(split.size, 100);
  assert.strictEqual(split.parts, 2);
  assert.strictEqual(v.find((x) => x.quant === 'Q8_0').tag, 'Q8_0');
  assert.ok(v.filter((x) => x.quant === 'Q4_K_M').every((x) => x.tag.endsWith('.gguf')), 'ambiguous quant falls back to file name');
  assert.strictEqual(bitsOf('UD-Q4_K_XL'), 5);
});

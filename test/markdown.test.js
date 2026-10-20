const test = require('node:test');
const assert = require('node:assert');
const { render, cleanCard } = require('../renderer/markdown');

test('escapes HTML and keeps formatting', () => {
  const html = render('Hallo <script>alert(1)</script> **fett** und `code`');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>fett</strong>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('links are data-href and only http(s)', () => {
  assert.ok(render('[x](https://a.com/b_c_d)').includes('data-href="https://a.com/b_c_d"'));
  assert.ok(!render('[x](javascript:alert(1))').includes('href'));
  assert.ok(!render('https://a.com/_x_/y').includes('<em>'));
});

test('code blocks, lists, tables, unclosed fence while streaming', () => {
  assert.ok(render('```js\nconst a = "<b>";\n```').includes('const a = &quot;&lt;b&gt;&quot;;'));
  assert.ok(render('- a\n- b').includes('<ul><li class="">a</li><li class="">b</li></ul>'));
  assert.ok(render('| a | b |\n|---|---|\n| 1 | 2 |').includes('<td>1</td>'));
  assert.ok(render('```py\nprint(1)').includes('print(1)'));
});

test('model cards lose front matter and raw HTML', () => {
  const md = cleanCard('---\nlicense: mit\n---\n<div align="center"><img src="https://x/y.png"></div>\n# Titel');
  assert.ok(!md.includes('license'));
  assert.ok(md.includes('![](https://x/y.png)'));
  assert.ok(!md.includes('<div'));
});

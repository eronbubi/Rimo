// Small, safe Markdown renderer for chat answers and model cards. All input is escaped first;
// only the formatting below produces HTML. Links get data-href and are opened by the app, never navigated.
(function (root) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : null);

  function inline(text, opts) {
    // Code, images and link tags are parked in slots so emphasis rules never touch their contents.
    const slots = [];
    const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = text.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
      const u = safeUrl(url);
      if (u && opts.images && /^https:/i.test(u)) return keep(`<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy">`);
      return alt ? keep(`<em>[${esc(alt)}]</em>`) : '';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
      const u = safeUrl(url);
      return u ? keep(`<a data-href="${esc(u)}" title="${esc(u)}">`) + label + keep('</a>') : label;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>)"]+[^\s<>)".,;:!?])/g, (_, pre, url) => pre + keep(`<a data-href="${esc(url)}" title="${esc(url)}">${esc(url)}</a>`));
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
  }

  function codeBlock(lang, code) {
    const l = esc(lang || '');
    return `<div class="code"><div class="code-head"><span>${l || 'Code'}</span><button class="code-copy" type="button">Kopieren</button></div><pre><code>${esc(code)}</code></pre></div>`;
  }

  function table(rows, opts) {
    const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim(), opts));
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    return `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function render(src, opts = {}) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join('\n'), opts).replace(/\n/g, '<br>')}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        flush();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++; // closing fence (or end of a still-streaming answer)
        out.push(codeBlock(fence[2], body.join('\n')));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2].replace(/\s#+\s*$/, ''), opts)}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        out.push(table(rows, opts));
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(q.join('\n'), opts)}</blockquote>`);
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m && /\d/.test(m[2]) === ordered) { items.push({ depth: m[1].length, text: m[3] }); i++; continue; }
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; continue; }
          break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((it) => {
          const task = /^\[([ xX])\]\s+(.*)$/s.exec(it.text);
          const body = task ? `<span class="task ${task[1] === ' ' ? '' : 'done'}"></span>${inline(task[2], opts)}` : inline(it.text, opts);
          return `<li class="${it.depth >= 2 ? 'nested' : ''}">${body.replace(/\n/g, '<br>')}</li>`;
        }).join('')}</${tag}>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  // Model cards: drop YAML front matter, turn <img> tags into Markdown images and strip other HTML.
  function cleanCard(md) {
    return String(md || '')
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)')
      .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|h\d|li|ul|ol|table|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }

  const api = { render, cleanCard, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis);

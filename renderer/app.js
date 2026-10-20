// Rimo UI: discover models on Hugging Face, manage downloads and installed models, chat, settings.
const call = window.rimo.call;
const esc = (v) => Markdown.escape(String(v ?? ''));
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

const state = {
  view: 'discover',
  sys: null,
  ollamaOk: null,
  settings: null,
  discover: { query: '', sort: 'downloads', items: [], cursor: null, loading: false, error: null, loaded: false },
  detail: null, // { id, loading, error, model, readmeOpen }
  models: [],
  modelsLoaded: false,
  modelsError: null,
  pulls: new Map(),
  chats: [],
  chat: null,
  pendingModel: null,
  streaming: null, // { streamId, chat, msg }
};

// ---- formatting ----------------------------------------------------------

const GIB = 1024 ** 3;
function fmtBytes(n) {
  if (!n) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB';
  if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}
const fmtGiB = (n) => (n / GIB).toFixed(n >= 10 * GIB ? 0 : 1).replace(/\.0$/, '') + ' GB';
function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + ' Mio.';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + ' k';
  return String(n);
}
const fmtCtx = (n) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : fmtCount(n));
function fmtParams(n) {
  if (!n) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + ' Mrd. Parameter';
  return Math.round(n / 1e6) + ' Mio. Parameter';
}
function ago(date) {
  if (!date) return '';
  const s = (Date.now() - new Date(date)) / 1000;
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'gestern';
  if (d < 30) return `vor ${d} Tagen`;
  if (d < 365) return `vor ${Math.floor(d / 30)} Mon.`;
  const y = Math.floor(d / 365);
  return `vor ${y} Jahr${y > 1 ? 'en' : ''}`;
}
function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} Min.`;
  return `${(sec / 3600).toFixed(1)} Std.`;
}
const COLORS = ['#2563eb', '#1d4ed8', '#0ea5e9', '#4f46e5', '#0891b2', '#3b82f6', '#6366f1', '#0284c7'];
function avatar(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<div class="avatar" style="background:${COLORS[h % COLORS.length]}">${esc(name[0].toUpperCase())}</div>`;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fitChip = (fit) => `<span class="fit ${fit.level}">${esc(fit.label)}</span>`;
const prettyName = (s) => s.replace(/[-_]GGUF$/i, '');

// ---- toasts & dialogs -------------------------------------------------------

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

function dialog({ title, text = '', input = null, ok = 'OK', danger = false }) {
  const back = $('#modal');
  back.innerHTML = `<div class="modal" role="dialog">
    <h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
    ${input !== null ? `<div class="field"><input class="input" id="dlg-input" value="${esc(input)}"></div>` : ''}
    <div class="actions"><button class="btn" data-r="0">Abbrechen</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>
  </div>`;
  back.hidden = false;
  const inp = $('#dlg-input', back);
  (inp || $('[data-r="1"]', back)).focus();
  if (inp) inp.select();
  return new Promise((resolve) => {
    const done = (yes) => {
      back.hidden = true;
      back.onclick = null;
      back.onkeydown = null;
      resolve(yes ? (inp ? inp.value : true) : false);
    };
    back.onclick = (e) => {
      if (e.target === back) return done(false);
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
    };
    back.onkeydown = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
  });
}

async function attempt(fn, msg) {
  try {
    return await fn();
  } catch (err) {
    toast((msg ? msg + ': ' : '') + err.message, 'error');
    return undefined;
  }
}

// ---- rendering --------------------------------------------------------------

const TITLES = { discover: 'Entdecken', models: 'Meine Modelle', chat: 'Chat', settings: 'Einstellungen' };

// Re-renders the current view; typed values, focus and scroll survive the re-render.
function render() {
  const keep = {};
  for (const el of view.querySelectorAll('input[id], textarea[id], select[id]')) keep[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  const focus = document.activeElement && document.activeElement.id;
  const scroll = view.scrollTop;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#top-title').textContent = state.view === 'discover' && state.detail ? `Entdecken › ${state.detail.id}` : TITLES[state.view];
  view.innerHTML = ({ discover: renderDiscover, models: renderModels, chat: renderChat, settings: renderSettings })[state.view]();
  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (!el || el.dataset.fresh) continue;
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
  }
  if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
  view.scrollTop = scroll;
  updateBadge();
  if (state.view === 'chat') afterChatRender();
}

function go(name) {
  if (state.view === name && name === 'discover' && state.detail) state.detail = null;
  state.view = name;
  render();
  view.scrollTop = 0;
  if (name === 'discover' && !state.discover.loaded) runSearch();
  if (name === 'models' || name === 'chat') loadModels();
  if (name === 'chat') loadChats();
}

// ---- discover ---------------------------------------------------------------

function renderDiscover() {
  if (state.detail) return renderDetail();
  const d = state.discover;
  const sorts = [['downloads', 'Beliebt'], ['trendingScore', 'Trend'], ['likes', 'Meiste Likes'], ['lastModified', 'Neu']];
  let body;
  if (d.error) body = `<div class="notice red">${icon('x')}<div>${esc(d.error)}</div></div>`;
  else if (!d.items.length && d.loading) body = `<div class="grid">${'<div class="skeleton"></div>'.repeat(9)}</div>`;
  else if (!d.items.length) body = `<div class="empty"><div class="big">${icon('search', 28)}</div><h2>Nichts gefunden</h2><p>Versuch einen anderen Suchbegriff, z. B. „qwen“, „llama“ oder „mistral“.</p></div>`;
  else {
    body = `<div class="grid">${d.items.map(modelCard).join('')}</div>
      ${d.cursor ? `<div class="more"><button class="btn" data-action="more" ${d.loading ? 'disabled' : ''}>${d.loading ? '<span class="spinner"></span>' : icon('chevron')} Mehr laden</button></div>` : ''}`;
  }
  return `<div class="page">
    <section class="hero">
      <h1>Finde dein Modell</h1>
      <p>Jedes GGUF-Modell von Hugging Face – herunterladen und direkt hier auf deinem PC chatten. Rimo zeigt dir, welche Version auf deine Grafikkarte passt.</p>
      <form class="searchbar" data-action="search-form">
        <label class="search-box">${icon('search', 20)}<input id="q" value="${esc(d.query)}" placeholder="Suchen: qwen3, llama, mistral … oder autor/modell einfügen" autocomplete="off" spellcheck="false"></label>
        <button class="btn" type="submit">Suchen</button>
      </form>
    </section>
    <div class="sorts">
      ${sorts.map(([k, l]) => `<button class="sort ${d.sort === k ? 'active' : ''}" data-action="sort" data-sort="${k}">${l}</button>`).join('')}
      <span class="count">${d.query ? `Ergebnisse für „${esc(d.query)}“` : 'Die beliebtesten GGUF-Modelle'}</span>
    </div>
    ${body}
  </div>`;
}

function modelCard(m) {
  return `<button class="card model-card" data-action="open-model" data-id="${esc(m.id)}">
    <div class="mc-top">${avatar(m.author)}<div style="min-width:0"><div class="mc-name">${esc(prettyName(m.name))}</div><div class="mc-author">${esc(m.author)}</div></div></div>
    <div class="mc-stats"><span>${icon('download', 14)}${fmtCount(m.downloads)}</span><span>${icon('heart', 14)}${fmtCount(m.likes)}</span><span>${icon('clock', 14)}${ago(m.lastModified)}</span></div>
    <div class="mc-chips">
      ${m.gated ? `<span class="chip amber">${icon('lock', 12)}Zugriff nötig</span>` : ''}
      ${m.pipeline ? `<span class="chip">${esc(pipelineName(m.pipeline))}</span>` : ''}
      ${m.license ? `<span class="chip gray">${esc(m.license)}</span>` : ''}
    </div>
  </button>`;
}

function pipelineName(p) {
  return { 'text-generation': 'Text', 'image-text-to-text': 'Text + Bild', 'feature-extraction': 'Embeddings', 'sentence-similarity': 'Embeddings', 'text-to-speech': 'Sprache', 'automatic-speech-recognition': 'Spracherkennung' }[p] || p;
}

async function runSearch(more = false) {
  const d = state.discover;
  d.loading = true;
  d.error = null;
  if (!more) { d.items = []; d.cursor = null; }
  render();
  try {
    const res = await call('hf:search', { query: d.query, sort: d.sort, cursor: more ? d.cursor : null });
    d.items = more ? d.items.concat(res.items) : res.items;
    d.cursor = res.cursor;
    d.loaded = true;
  } catch (err) {
    d.error = err.message;
  }
  d.loading = false;
  if (state.view === 'discover' && !state.detail) render();
}

async function submitSearch(text) {
  const q = text.trim();
  if (q.includes('/')) {
    const id = await call('hf:parse', q).catch(() => null);
    if (id) return openModel(id);
  }
  state.discover.query = q;
  runSearch();
}

async function openModel(id) {
  state.view = 'discover';
  state.detail = { id, loading: true, error: null, model: null, readmeOpen: false };
  render();
  view.scrollTop = 0;
  if (!state.modelsLoaded) loadModels();
  try {
    const m = await call('hf:model', id);
    if (state.detail && state.detail.id === id) state.detail.model = m;
  } catch (err) {
    if (state.detail && state.detail.id === id) state.detail.error = err.message;
  }
  if (state.detail && state.detail.id === id) {
    state.detail.loading = false;
    if (state.view === 'discover') render();
  }
}

function installedName(ollamaName) {
  const lower = ollamaName.toLowerCase();
  const m = state.models.find((x) => x.name.toLowerCase() === lower);
  return m ? m.name : null;
}

function renderDetail() {
  const det = state.detail;
  const back = `<button class="btn ghost back" data-action="back">${icon('back')} Zurück</button>`;
  if (det.loading) return `<div class="page">${back}<div class="loading"><span class="spinner"></span>Lade Modell-Infos von Hugging Face …</div></div>`;
  if (det.error) return `<div class="page">${back}<div class="notice red">${icon('x')}<div>${esc(det.error)}</div></div></div>`;
  const m = det.model;
  const hw = m.hardware;
  const reco = m.variants.find((v) => v.path === m.recommended);
  const facts = [
    fmtParams(m.params) && `<span class="chip">${esc(fmtParams(m.params))}</span>`,
    m.architecture && `<span class="chip gray">Architektur: ${esc(m.architecture)}</span>`,
    m.contextLength && `<span class="chip gray">Kontext bis ${fmtCtx(m.contextLength)}</span>`,
    m.license && `<span class="chip gray">Lizenz: ${esc(m.license)}</span>`,
    m.baseModel && `<span class="chip gray">Basis: ${esc(m.baseModel)}</span>`,
  ].filter(Boolean).join('');
  const hwText = hw.vram ? `${hw.gpuName ? esc(hw.gpuName) + ', ' : ''}${fmtGiB(hw.vram)} VRAM, ${fmtCtx(hw.ctx)} Kontext` : `keine Grafikkarte erkannt, ${fmtGiB(hw.ram)} RAM`;
  return `<div class="page">
    ${back}
    <div class="card detail-head">
      ${avatar(m.author)}
      <div style="flex:1;min-width:0">
        <h1>${esc(prettyName(m.name))}</h1>
        <div class="muted" style="margin-top:4px">von <b>${esc(m.author)}</b> · ${icon('download', 13).replace('class="ic"', 'class="ic" style="display:inline;vertical-align:-2px"')} ${fmtCount(m.downloads)} · ♥ ${fmtCount(m.likes)} · aktualisiert ${ago(m.lastModified)}</div>
        <div class="facts">${facts}</div>
      </div>
      <button class="btn small" data-href="https://huggingface.co/${esc(m.id)}">${icon('external', 15)} Hugging Face</button>
    </div>
    ${m.gated ? `<div class="notice">${icon('lock')}<div><b>Zugriffsbeschränktes Modell.</b> Du musst auf Hugging Face eingeloggt die Bedingungen akzeptieren und deinen Ollama-Schlüssel (Datei <code>%USERPROFILE%\\.ollama\\id_ed25519.pub</code>) in deinen HF-Einstellungen unter „SSH Keys“ hinterlegen. Sonst schlägt der Download fehl.</div></div>` : ''}
    ${!m.variants.length ? `<div class="notice red">${icon('x')}<div>Dieses Repo enthält keine GGUF-Datei, die Ollama laden kann.</div></div>` : ''}
    ${reco ? `<div class="reco">
      <div class="reco-icon">${icon('spark', 22)}</div>
      <div class="reco-text"><b>Empfehlung für deinen PC: ${esc(reco.quant || reco.file)}</b><div class="muted" style="margin-top:3px">${fmtBytes(reco.size)} · ${esc(reco.quality)} · ${esc(reco.fit.label)}</div></div>
      <div data-pull-slot="${esc(reco.ollamaName)}" style="display:flex;align-items:center;gap:6px">${variantAction(reco, true)}</div>
    </div>` : ''}
    ${m.variants.length ? `<div class="card files"><table>
      <thead><tr><th>Version</th><th>Qualität</th><th>Grösse</th><th>Dein PC <span style="text-transform:none;letter-spacing:0;font-weight:400">(${hwText})</span></th><th></th></tr></thead>
      <tbody>${m.variants.map((v) => variantRow(v, v.path === m.recommended)).join('')}</tbody>
    </table></div>` : ''}
    ${m.readme ? `<div class="card">
      <button class="readme-toggle ${det.readmeOpen ? 'open' : ''}" data-action="readme">Modellkarte ${icon('chevron')}</button>
      ${det.readmeOpen ? `<div class="card-body md" style="padding-top:0">${Markdown.render(Markdown.cleanCard(m.readme), { images: true })}</div>` : ''}
    </div>` : ''}
  </div>`;
}

function variantRow(v, recommended) {
  const bar = Math.min(1, (v.bits || 0) / 8.5) * 100;
  return `<tr class="${recommended ? 'recommended' : ''}">
    <td><div class="q">${esc(v.quant || '?')} ${recommended ? '<span class="chip" style="margin-left:6px">Empfohlen</span>' : ''} ${v.split ? `<span class="chip gray" title="Besteht aus ${v.parts} Teilen. Ollama kann geteilte GGUF-Dateien je nach Version nicht laden.">${v.parts} Teile</span>` : ''}</div><div class="fname" title="${esc(v.path)}">${esc(v.file)}</div></td>
    <td>${esc(v.quality)}<div class="qbar"><i style="width:${bar}%"></i></div></td>
    <td><b>${fmtBytes(v.size)}</b></td>
    <td>${fitChip(v.fit)}<div class="faint" style="font-size:12px;margin-top:3px">braucht ca. ${fmtGiB(v.fit.need)}${v.fit.level === 'mixed' ? `, ${Math.round(v.fit.gpuShare * 100)} % auf GPU` : ''}</div></td>
    <td class="act" data-pull-slot="${esc(v.ollamaName)}">${variantAction(v)}</td>
  </tr>`;
}

function variantAction(v, big = false) {
  const inst = installedName(v.ollamaName);
  if (inst) return `<button class="btn ${big ? '' : 'small'} primary" data-action="chat-with" data-name="${esc(inst)}">${icon('chat', 15)} Chatten</button>`;
  const p = state.pulls.get(v.ollamaName);
  if (p && !p.done) return miniProgress(p);
  const label = `${prettyName(state.detail.model.name)} · ${v.quant || v.file}`;
  return `<button class="btn ${big ? 'primary' : 'small'}" data-action="pull" data-name="${esc(v.ollamaName)}" data-label="${esc(label)}" data-level="${v.fit.level}">${icon('download', 15)} Herunterladen</button>`;
}

function miniProgress(p) {
  const pct = p.total ? Math.floor((p.completed / p.total) * 100) : 0;
  return `<div class="mini-progress"><span>${p.total ? pct + ' %' : esc(p.status)}${p.speed ? ' · ' + fmtBytes(p.speed) + '/s' : ''}</span><div class="progress ${p.total ? '' : 'indet'}"><i style="width:${pct}%"></i></div></div>
    <button class="btn small icon ghost" data-action="pull-cancel" data-name="${esc(p.name)}" title="Abbrechen">${icon('x', 15)}</button>`;
}

// ---- downloads --------------------------------------------------------------

async function startPull(name, label, level) {
  if (level === 'no') {
    const ok = await dialog({ title: 'Wahrscheinlich zu gross', text: 'Diese Version braucht mehr Speicher, als dein PC hat. Sie wird kaum oder gar nicht laufen. Trotzdem herunterladen?', ok: 'Trotzdem laden' });
    if (!ok) return;
  }
  const p = await attempt(() => call('pull:start', { name, label }), 'Download');
  if (p) {
    state.pulls.set(p.name, p);
    toast(`Download gestartet: ${label || name}`);
    render();
  }
}

function onPull(p) {
  const before = state.pulls.get(p.name);
  state.pulls.set(p.name, p);
  if (p.done && before && !before.done) {
    if (p.error) toast(`${p.label}: ${p.error}`, p.error === 'Abgebrochen' ? '' : 'error');
    else toast(`${p.label} ist bereit zum Chatten`, 'ok');
    render();
    return;
  }
  // live update without a full re-render
  for (const el of document.querySelectorAll('[data-pull-slot]')) {
    if (el.dataset.pullSlot === p.name) el.innerHTML = miniProgress(p);
  }
  for (const el of document.querySelectorAll('[data-pull-row]')) {
    if (el.dataset.pullRow === p.name) el.outerHTML = pullRow(p);
  }
  updateBadge();
}

function updateBadge() {
  const n = [...state.pulls.values()].filter((p) => !p.done).length;
  const b = $('#dl-badge');
  b.hidden = !n;
  b.textContent = n;
}

function pullRow(p) {
  const pct = p.total ? (p.completed / p.total) * 100 : 0;
  const eta = p.speed && p.total ? fmtDuration((p.total - p.completed) / p.speed) : '';
  const meta = p.error ? esc(p.error)
    : p.done ? 'Fertig'
      : p.total ? `${fmtBytes(p.completed)} von ${fmtBytes(p.total)} · ${Math.floor(pct)} %${p.speed ? ' · ' + fmtBytes(p.speed) + '/s' : ''}${eta ? ' · noch ' + eta : ''}`
        : esc(p.status);
  return `<div class="card dl ${p.error ? 'error' : ''}" data-pull-row="${esc(p.name)}">
    <div class="reco-icon" style="width:38px;height:38px;border-radius:10px">${icon(p.done && !p.error ? 'check' : 'download', 18)}</div>
    <div class="dl-main"><div class="dl-name">${esc(p.label)}</div><div class="dl-meta">${meta}</div>
      ${p.done ? '' : `<div class="progress ${p.total ? '' : 'indet'}"><i style="width:${pct}%"></i></div>`}</div>
    ${p.done
    ? `<button class="btn small ghost" data-action="pull-dismiss" data-name="${esc(p.name)}">${icon('x', 15)}</button>`
    : `<button class="btn small" data-action="pull-cancel" data-name="${esc(p.name)}">Abbrechen</button>`}
  </div>`;
}

// ---- my models --------------------------------------------------------------

async function loadModels() {
  try {
    state.models = await call('models:list');
    state.modelsError = null;
  } catch (err) {
    state.modelsError = err.message;
  }
  state.modelsLoaded = true;
  if (!state.pendingModel || !state.models.some((m) => m.name === state.pendingModel)) {
    const last = state.settings && state.settings.lastModel;
    state.pendingModel = state.models.some((m) => m.name === last) ? last : (state.models[0] || {}).name || null;
  }
  if (state.view === 'models' || (state.view === 'discover' && state.detail && state.detail.model)) render();
  if (state.view === 'chat' && !state.streaming) render();
}

function capChips(caps) {
  const names = { thinking: 'Denken', tools: 'Werkzeuge', vision: 'Bilder', embedding: 'Embeddings' };
  return (caps || []).filter((c) => names[c]).map((c) => `<span class="chip gray">${names[c]}</span>`).join('');
}

function renderModels() {
  const pulls = [...state.pulls.values()];
  let list;
  if (state.modelsError) {
    list = `<div class="notice red">${icon('x')}<div><b>${esc(state.modelsError)}</b><br>Rimo nutzt Ollama, um Modelle zu laden und auszuführen.</div>
      <button class="btn small" style="margin-left:auto" data-action="start-ollama">Ollama starten</button></div>`;
  } else if (!state.modelsLoaded) {
    list = '<div class="loading"><span class="spinner"></span>Lade Modelle …</div>';
  } else if (!state.models.length) {
    list = `<div class="card empty"><div class="big">${icon('box', 28)}</div><h2>Noch keine Modelle</h2><p>Such dir unter „Entdecken“ ein Modell aus und lade es herunter.</p><button class="btn primary" data-action="nav" data-view="discover">${icon('compass')} Modelle entdecken</button></div>`;
  } else {
    list = `<div class="installed">${state.models.map((m) => `<div class="card inst">
      ${avatar(m.author)}
      <div class="inst-main">
        <div class="inst-title"><span class="t" title="${esc(m.name)}">${esc(m.title)}</span><span class="chip">${esc(m.tag)}</span></div>
        <div class="inst-meta">
          <span class="muted" style="font-size:12.5px">${esc(m.source === 'hf' ? m.author + ' · Hugging Face' : m.author)}</span>
          <span class="chip gray">${fmtBytes(m.size)}</span>
          ${m.params ? `<span class="chip gray">${esc(m.params)}</span>` : ''}
          ${m.quant ? `<span class="chip gray">${esc(m.quant)}</span>` : ''}
          ${capChips(m.capabilities)}
          ${fitChip(m.fit)}
          ${m.loaded ? `<span class="loaded">${icon('cpu', 14)}Geladen · ${fmtGiB(m.loaded.vram)} VRAM</span>` : ''}
        </div>
      </div>
      <div class="inst-actions">
        <button class="btn small primary" data-action="chat-with" data-name="${esc(m.name)}">${icon('chat', 15)} Chatten</button>
        <button class="btn small icon" data-action="model-settings" data-name="${esc(m.name)}" title="Einstellungen">${icon('sliders', 16)}</button>
        <button class="btn small icon danger" data-action="model-delete" data-name="${esc(m.name)}" title="Löschen">${icon('trash', 16)}</button>
      </div>
    </div>`).join('')}</div>`;
  }
  return `<div class="page">
    <div class="page-head"><div><h1>Meine Modelle</h1><p class="lead">${state.models.length ? `${state.models.length} Modelle · ${fmtBytes(state.models.reduce((s, m) => s + m.size, 0))} auf der Festplatte` : 'Alles, was du heruntergeladen hast'}</p></div>
      <button class="btn" data-action="open-folder" data-which="models">${icon('folder', 16)} Modell-Ordner</button></div>
    ${pulls.length ? `<h2>Downloads</h2><div class="dl-list">${pulls.map(pullRow).join('')}</div>` : ''}
    <form class="card pull-by-name" data-action="pull-form">
      ${icon('download', 18)}
      <input class="input" id="pull-name" placeholder="Direkt laden: hf.co/autor/repo:Q4_K_M oder Ollama-Name wie llama3.2" spellcheck="false">
      <button class="btn primary" type="submit">Laden</button>
    </form>
    <h2>Installiert</h2>
    ${list}
  </div>`;
}

async function deleteModel(name) {
  const ok = await dialog({ title: 'Modell löschen?', text: `„${name}“ wird von der Festplatte entfernt. Du kannst es später wieder herunterladen.`, ok: 'Löschen', danger: true });
  if (!ok) return;
  if (await attempt(() => call('models:delete', name), 'Löschen')) {
    toast('Modell gelöscht');
    loadModels();
  }
}

// ---- model settings drawer ----------------------------------------------------

async function openModelSettings(name) {
  const back = $('#drawer');
  back.innerHTML = '<div class="drawer"><div class="loading"><span class="spinner"></span>Lade …</div></div>';
  back.hidden = false;
  back.onclick = (e) => { if (e.target === back) closeDrawer(); };
  let info;
  try {
    info = await call('models:info', name);
  } catch (err) {
    closeDrawer();
    return toast(err.message, 'error');
  }
  const s = info.settings;
  const think = info.capabilities.includes('thinking');
  if (!info.fits.some((f) => f.ctx === Number(s.num_ctx))) info.fits.push({ ctx: Number(s.num_ctx), label: 'eigener Wert', level: 'mixed', need: 0 });
  back.innerHTML = `<div class="drawer">
    <div class="drawer-head"><div style="flex:1;min-width:0"><h2>Modell-Einstellungen</h2><div class="sub">${esc(info.name)}</div></div>
      <button class="btn icon ghost" data-d="close">${icon('x')}</button></div>
    <div class="drawer-body">
      ${info.hasOwn ? '' : '<div class="notice blue" style="font-size:13px">Dieses Modell nutzt die Standardwerte aus den Einstellungen. Speichern legt eigene Werte nur für dieses Modell an.</div>'}
      <div class="field"><label for="ms-system">System-Prompt</label>
        <textarea class="textarea" id="ms-system" placeholder="z. B. Du bist ein hilfsbereiter Assistent und antwortest auf Deutsch.">${esc(s.system)}</textarea>
        <span class="hint">Feste Anweisung, die vor jedem Chat mit diesem Modell steht.</span></div>
      <div class="field"><label for="ms-temp">Temperatur</label>
        <div class="range-row"><input type="range" id="ms-temp" min="0" max="2" step="0.05" value="${Number(s.temperature)}"><output id="ms-temp-out">${Number(s.temperature).toFixed(2)}</output></div>
        <span class="hint">Niedrig = genau und gleichbleibend, hoch = kreativ und abwechslungsreich.</span></div>
      <div class="field"><label for="ms-ctx">Kontextlänge</label>
        <select class="select" id="ms-ctx">${info.fits.sort((a, b) => a.ctx - b.ctx).map((f) => `<option value="${f.ctx}" ${f.ctx === Number(s.num_ctx) ? 'selected' : ''}>${fmtCtx(f.ctx)} Tokens — ${esc(f.label)}</option>`).join('')}</select>
        <span class="hint">Wie viel vom Gespräch das Modell sich merkt. Mehr Kontext braucht mehr VRAM. Maximum: ${fmtCtx(info.ctxMax)}.</span></div>
      <div class="fit-box" id="ms-fit"></div>
      ${think ? `<div class="switch-row"><div><div class="t">Denken (Reasoning)</div><div class="hint muted" style="font-size:12.5px">Das Modell denkt vor der Antwort nach. Besser bei schweren Fragen, aber langsamer.</div></div>
        <label class="switch"><input type="checkbox" id="ms-think" ${s.think ? 'checked' : ''}><span></span></label></div>` : ''}
    </div>
    <div class="drawer-foot">
      ${info.hasOwn ? '<button class="btn ghost" data-d="reset" style="margin-right:auto">Standard verwenden</button>' : ''}
      <button class="btn" data-d="close">Abbrechen</button>
      <button class="btn primary" data-d="save">Speichern</button>
    </div>
  </div>`;
  const showFit = () => {
    const f = info.fits.find((x) => x.ctx === Number($('#ms-ctx').value));
    $('#ms-fit').innerHTML = f && f.need ? `${fitChip(f)}<div class="muted" style="margin-top:4px">Braucht ca. ${fmtGiB(f.need)} (Modell ${fmtBytes(info.size)} + Kontext-Speicher ${fmtGiB(f.kv)}). Frei auf der GPU: ca. ${fmtGiB(f.usable)}.</div>` : '';
  };
  showFit();
  $('#ms-ctx').onchange = showFit;
  $('#ms-temp').oninput = (e) => { $('#ms-temp-out').textContent = Number(e.target.value).toFixed(2); };
  back.onclick = async (e) => {
    if (e.target === back) return closeDrawer();
    const b = e.target.closest('[data-d]');
    if (!b) return;
    if (b.dataset.d === 'close') return closeDrawer();
    if (b.dataset.d === 'reset') {
      await attempt(() => call('settings:set', { models: { [name]: null } }));
      toast('Standardwerte werden verwendet');
    } else {
      const value = { system: $('#ms-system').value, temperature: Number($('#ms-temp').value), num_ctx: Number($('#ms-ctx').value), think: think ? $('#ms-think').checked : s.think };
      await attempt(() => call('settings:set', { models: { [name]: value } }));
      toast('Gespeichert', 'ok');
    }
    state.settings = await call('settings:get');
    closeDrawer();
    loadModels();
  };
}

function closeDrawer() {
  const back = $('#drawer');
  back.hidden = true;
  back.innerHTML = '';
}

// ---- chat -------------------------------------------------------------------

async function loadChats() {
  state.chats = await attempt(() => call('chats:list')) || [];
  renderChatList();
}

function currentModel() {
  return state.chat ? state.chat.model : state.pendingModel;
}

function chatGroups() {
  const today = new Date().setHours(0, 0, 0, 0);
  const groups = [['Heute', []], ['Gestern', []], ['Letzte 7 Tage', []], ['Älter', []]];
  for (const c of state.chats) {
    const i = c.updatedAt >= today ? 0 : c.updatedAt >= today - 864e5 ? 1 : c.updatedAt >= today - 7 * 864e5 ? 2 : 3;
    groups[i][1].push(c);
  }
  return groups.filter((g) => g[1].length);
}

function chatListHtml() {
  if (!state.chats.length) return '<div class="faint" style="padding:18px 10px;font-size:13px;text-align:center">Noch keine Chats</div>';
  return chatGroups().map(([label, list]) => `<div class="chat-group">${label}</div>${list.map((c) => `
    <div class="chat-item ${state.chat && state.chat.id === c.id ? 'active' : ''}" data-action="open-chat" data-id="${c.id}" role="button">
      <div class="ci-main"><div class="ci-title">${esc(c.title || 'Neuer Chat')}</div><div class="ci-model">${esc(displayModel(c.model))}</div></div>
      <button class="ci-ren" data-action="rename-chat" data-id="${c.id}" title="Umbenennen">${icon('edit', 14)}</button>
      <button class="ci-del" data-action="delete-chat" data-id="${c.id}" title="Löschen">${icon('trash', 14)}</button>
    </div>`).join('')}`).join('');
}

function renderChatList() {
  const el = $('#chat-items');
  if (el) el.innerHTML = chatListHtml();
}

function displayModel(name) {
  if (!name) return '';
  const m = state.models.find((x) => x.name === name);
  if (m) return `${m.title} · ${m.tag}`;
  const hf = /^hf\.co\/[^/]+\/([^:]+):?(.*)$/i.exec(name);
  return hf ? `${prettyName(hf[1])} · ${hf[2] || 'latest'}` : name;
}

function renderChat() {
  const model = currentModel();
  const options = state.models.map((m) => `<option value="${esc(m.name)}" ${m.name === model ? 'selected' : ''}>${esc(m.title)} · ${esc(m.tag)}</option>`).join('');
  const missing = model && state.modelsLoaded && !state.models.some((m) => m.name === model);
  const busy = !!(state.streaming && state.chat && state.streaming.chat === state.chat);
  return `<div class="chat-layout">
    <div class="chat-list">
      <div class="chat-list-head"><button class="btn primary" data-action="new-chat">${icon('plus')} Neuer Chat</button></div>
      <div class="chat-items" id="chat-items">${chatListHtml()}</div>
    </div>
    <div class="convo">
      <div class="convo-head">
        <div class="model-pick"><select id="model-select" data-fresh="1" ${state.models.length ? '' : 'disabled'}>
          ${missing ? `<option value="${esc(model)}" selected>${esc(displayModel(model))} (nicht installiert)</option>` : ''}
          ${options || '<option>Kein Modell installiert</option>'}
        </select>${icon('chevron', 16)}</div>
        ${model && !missing ? `<button class="btn icon" data-action="model-settings" data-name="${esc(model)}" title="Modell-Einstellungen">${icon('sliders', 16)}</button>` : ''}
        <div class="convo-title">${state.chat && state.chat.title ? esc(state.chat.title) : ''}</div>
      </div>
      <div class="messages" id="messages">${messagesHtml()}</div>
      <div class="composer-wrap">
        <div class="composer">
          <textarea id="composer" rows="1" placeholder="${state.models.length ? 'Schreib eine Nachricht …' : 'Lade zuerst ein Modell herunter'}" ${state.models.length ? '' : 'disabled'}></textarea>
          ${busy
    ? `<button class="send stop" data-action="stop" title="Stoppen">${icon('stop', 16)}</button>`
    : `<button class="send" data-action="send" title="Senden" ${state.models.length ? '' : 'disabled'}>${icon('send', 18)}</button>`}
        </div>
        <div class="composer-hint">Enter sendet · Umschalt+Enter für neue Zeile · läuft komplett lokal auf deinem PC</div>
      </div>
    </div>
  </div>`;
}

function messagesHtml() {
  const chat = state.chat;
  if (!chat || !chat.messages.length) {
    if (state.modelsLoaded && !state.models.length) {
      return `<div class="welcome"><div class="bot">${icon('box', 28)}</div><h1>Noch kein Modell da</h1><p class="lead">Lade unter „Entdecken“ ein Modell herunter, dann kannst du hier chatten.</p><button class="btn primary" style="margin-top:18px" data-action="nav" data-view="discover">${icon('compass')} Modelle entdecken</button></div>`;
    }
    const tips = [
      ['Erklären', 'Erklär mir einfach, wie ein Sprachmodell funktioniert.'],
      ['Schreiben', 'Schreib eine kurze, freundliche E-Mail, mit der ich einen Termin verschiebe.'],
      ['Programmieren', 'Schreib eine Python-Funktion, die prüft, ob ein Wort ein Palindrom ist.'],
      ['Ideen', 'Gib mir 5 Ideen für ein Wochenende ohne viel Geld.'],
    ];
    return `<div class="welcome"><div class="bot">${icon('spark', 28)}</div><h1>Worüber willst du reden?</h1>
      <p class="lead">${currentModel() ? `Du chattest mit <b>${esc(displayModel(currentModel()))}</b> – alles bleibt auf deinem PC.` : ''}</p>
      <div class="suggestions">${tips.map(([t, p]) => `<button class="suggestion" data-action="suggest" data-text="${esc(p)}"><b>${t}</b>${esc(p)}</button>`).join('')}</div></div>`;
  }
  return `<div class="msgs-inner">${chat.messages.map((m, i) => messageHtml(m, i)).join('')}</div>`;
}

function splitThink(m) {
  let content = m.content || '';
  let thinking = m.thinking || '';
  const t = /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(content);
  if (t) {
    thinking += t[1];
    content = content.slice(t[0].length);
  }
  return { content: content.replace(/^\s+/, ''), thinking: thinking.trim(), thinkingLive: m.pending && !t?.[2] && !content.trim() };
}

function bubbleHtml(m, i) {
  if (m.role === 'user') return esc(m.content);
  if (m.error) return `<b>Fehler:</b> ${esc(m.error)}`;
  const { content, thinking, thinkingLive } = splitThink(m);
  const live = m.pending && thinkingLive && thinking;
  const think = thinking ? `<details class="think" data-think="${i}" ${live || m.thinkOpen ? 'open' : ''}><summary>${icon('brain', 15)}${live ? '<span class="pulse">Denkt nach …</span>' : 'Gedankengang anzeigen'}</summary><div class="think-body">${esc(thinking)}</div></details>` : '';
  const body = content ? `<div class="md">${Markdown.render(content)}</div>` : m.pending && !thinking ? '<div class="typing"><i></i><i></i><i></i></div>' : '';
  return think + body;
}

function statsText(m) {
  if (m.aborted) return 'Gestoppt';
  const s = m.stats;
  if (!s || !s.evalCount || !s.evalDuration) return '';
  const tps = s.evalCount / (s.evalDuration / 1e9);
  return `${s.evalCount} Tokens · ${tps.toFixed(1)} Tokens/s${s.doneReason === 'length' ? ' · abgeschnitten (Kontext voll)' : ''}`;
}

function messageHtml(m, i) {
  if (m.role === 'user') return `<div class="msg user" data-mid="${i}"><div class="bubble">${esc(m.content)}</div></div>`;
  const last = i === state.chat.messages.length - 1;
  const tools = m.pending ? '' : `<div class="msg-tools">
    ${m.error ? '' : `<button data-action="copy-msg" data-mid="${i}">${icon('copy', 13)} Kopieren</button>`}
    ${last ? `<button data-action="regenerate">${icon('refresh', 13)} Neu generieren</button>` : ''}
    <span class="stats">${esc(statsText(m))}</span></div>`;
  return `<div class="msg assistant ${m.error ? 'error' : ''}" data-mid="${i}"><div class="bot">${icon('spark', 17)}</div>
    <div style="min-width:0;flex:1;display:flex;flex-direction:column;align-items:flex-start"><div class="bubble">${bubbleHtml(m, i)}</div>${tools}</div></div>`;
}

function afterChatRender() {
  const box = $('#messages');
  if (box) box.scrollTop = box.scrollHeight;
  const ta = $('#composer');
  if (ta) autoGrow(ta);
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

let bubbleFrame = 0;
function updateStreamingBubble() {
  if (bubbleFrame) return;
  bubbleFrame = requestAnimationFrame(() => {
    bubbleFrame = 0;
    const st = state.streaming;
    if (!st || state.view !== 'chat' || state.chat !== st.chat) return;
    const i = st.chat.messages.indexOf(st.msg);
    const el = document.querySelector(`.msg[data-mid="${i}"] .bubble`);
    const box = $('#messages');
    if (!el || !box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    el.innerHTML = bubbleHtml(st.msg, i);
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

function cleanChat(chat) {
  return {
    ...chat,
    messages: chat.messages.map((m) => {
      const { pending, thinkOpen, ...rest } = m;
      return rest;
    }),
  };
}

async function saveChat(chat) {
  await attempt(() => call('chats:save', cleanChat(chat)), 'Speichern');
  state.chats = await attempt(() => call('chats:list')) || state.chats;
  renderChatList();
}

function newChat() {
  if (state.streaming) stopStreaming();
  state.chat = null;
  if (state.view !== 'chat') go('chat');
  else render();
  setTimeout(() => $('#composer') && $('#composer').focus(), 0);
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || state.streaming) return;
  const model = currentModel();
  if (!model) return toast('Wähle zuerst ein Modell aus', 'error');
  if (!state.chat) state.chat = { id: uid(), title: '', model, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  const chat = state.chat;
  chat.messages.push({ role: 'user', content: text, at: Date.now() });
  if (!chat.title) chat.title = text.replace(/\s+/g, ' ').slice(0, 60);
  const ta = $('#composer');
  if (ta) ta.value = '';
  await generate(chat);
}

async function generate(chat) {
  const history = chat.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThink(m).content : m.content }));
  const msg = { role: 'assistant', content: '', thinking: '', model: chat.model, at: Date.now(), pending: true };
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  const streamId = uid();
  state.streaming = { streamId, chat, msg };
  render();
  saveChat(chat);
  try {
    await call('chat:send', { streamId, model: chat.model, messages: history });
  } catch (err) {
    finishStream({ streamId, error: err.message });
  }
}

function onChat(ev) {
  const st = state.streaming;
  if (!st || st.streamId !== ev.streamId) return;
  if (ev.delta) st.msg.content += ev.delta;
  if (ev.thinking) st.msg.thinking += ev.thinking;
  if (ev.done || ev.error) return finishStream(ev);
  updateStreamingBubble();
}

function finishStream(ev) {
  const st = state.streaming;
  if (!st || st.streamId !== ev.streamId) return;
  const m = st.msg;
  m.pending = false;
  if (ev.error) m.error = ev.error;
  if (ev.stats) m.stats = ev.stats;
  if (ev.aborted) m.aborted = true;
  if (!m.content && !m.thinking && !m.error && ev.aborted) m.content = '_(gestoppt)_';
  st.chat.updatedAt = Date.now();
  state.streaming = null;
  saveChat(st.chat);
  if (state.view === 'chat') render();
  loadModels();
}

function stopStreaming() {
  if (state.streaming) call('chat:stop', state.streaming.streamId).catch(() => {});
}

async function openChat(id) {
  if (state.streaming && state.streaming.chat.id === id) {
    state.chat = state.streaming.chat;
  } else {
    const c = await attempt(() => call('chats:get', id));
    if (!c) return;
    state.chat = c;
  }
  if (state.chat.model) state.pendingModel = state.chat.model;
  render();
}

async function renameChat(id) {
  const c = state.chats.find((x) => x.id === id);
  const name = await dialog({ title: 'Chat umbenennen', input: c ? c.title : '', ok: 'Speichern' });
  if (!name || !name.trim()) return;
  const chat = state.chat && state.chat.id === id ? state.chat : await call('chats:get', id);
  chat.title = name.trim();
  await saveChat(chat);
  if (state.chat && state.chat.id === id) render();
}

async function deleteChat(id) {
  const ok = await dialog({ title: 'Chat löschen?', text: 'Der Verlauf wird endgültig gelöscht.', ok: 'Löschen', danger: true });
  if (!ok) return;
  if (state.streaming && state.streaming.chat.id === id) stopStreaming();
  await attempt(() => call('chats:delete', id));
  if (state.chat && state.chat.id === id) state.chat = null;
  await loadChats();
  render();
}

async function chatWith(name) {
  state.pendingModel = name;
  state.chat = null;
  state.detail = state.view === 'discover' ? state.detail : null;
  state.settings = await attempt(() => call('settings:set', { lastModel: name })) || state.settings;
  go('chat');
  setTimeout(() => $('#composer') && $('#composer').focus(), 50);
}

// ---- settings ---------------------------------------------------------------

function renderSettings() {
  const s = state.settings;
  const sys = state.sys || {};
  if (!s) return '<div class="loading"><span class="spinner"></span></div>';
  const d = s.defaults;
  const ctxs = [2048, 4096, 8192, 16384, 32768, 65536];
  return `<div class="page">
    <div class="page-head"><div><h1>Einstellungen</h1><p class="lead">Standardwerte für alle Modelle. Pro Modell kannst du sie unter „Meine Modelle“ anpassen.</p></div></div>
    <div class="settings-grid">
      <div>
        <form class="card section" data-action="save-defaults">
          <h2>Standard für Chats</h2>
          <div class="field"><label for="st-system">System-Prompt</label>
            <textarea class="textarea" id="st-system" placeholder="z. B. Antworte immer auf Deutsch.">${esc(d.system)}</textarea></div>
          <div class="row2">
            <div class="field"><label for="st-temp">Temperatur</label>
              <div class="range-row"><input type="range" id="st-temp" min="0" max="2" step="0.05" value="${Number(d.temperature)}"><output id="st-temp-out">${Number(d.temperature).toFixed(2)}</output></div></div>
            <div class="field"><label for="st-ctx">Kontextlänge</label>
              <select class="select" id="st-ctx">${ctxs.map((c) => `<option value="${c}" ${c === Number(d.num_ctx) ? 'selected' : ''}>${fmtCtx(c)} Tokens</option>`).join('')}</select></div>
          </div>
          <div class="switch-row"><div><div class="t">Denken bei Reasoning-Modellen</div><div class="muted" style="font-size:12.5px">Gilt für Modelle wie Qwen3 oder DeepSeek-R1.</div></div>
            <label class="switch"><input type="checkbox" id="st-think" ${d.think ? 'checked' : ''}><span></span></label></div>
          <button class="btn primary" type="submit">Speichern</button>
        </form>
        <form class="card section" data-action="save-ollama">
          <h2>Ollama</h2>
          <div class="field"><label for="st-url">Adresse</label><input class="input" id="st-url" value="${esc(s.ollamaUrl)}" spellcheck="false">
            <span class="hint">Normalerweise http://127.0.0.1:11434. Hier läuft Ollama, das die Modelle lädt und ausführt.</span></div>
          <div class="field"><label for="st-vram">VRAM für den Check (GB)</label><input class="input" id="st-vram" type="number" min="0" step="0.5" value="${s.vramOverrideGB || ''}" placeholder="Automatisch: ${sys.detectedVram ? fmtGiB(sys.detectedVram) : 'nicht erkannt'}">
            <span class="hint">Leer lassen für automatische Erkennung.</span></div>
          <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Speichern</button>
            <button class="btn" type="button" data-action="start-ollama">Ollama starten</button>
            <button class="btn" type="button" data-action="open-folder" data-which="models">${icon('folder', 16)} Modell-Ordner</button></div>
        </form>
      </div>
      <div>
        <div class="card section">
          <h2>Dein PC</h2>
          <div class="kv"><span>Grafikkarte</span><span>${esc(sys.gpuName || 'nicht erkannt')}</span></div>
          <div class="kv"><span>VRAM</span><span>${sys.vram ? fmtGiB(sys.vram) : '–'}</span></div>
          <div class="kv"><span>Arbeitsspeicher</span><span>${sys.ram ? fmtGiB(sys.ram) : '–'}</span></div>
          <div class="kv"><span>Ollama</span><span>${sys.ollamaVersion ? 'Version ' + esc(sys.ollamaVersion) : 'nicht erreichbar'}</span></div>
        </div>
        <div class="card section">
          <h2>Über Rimo</h2>
          <div class="kv"><span>Version</span><span>${esc(sys.appVersion || '')}</span></div>
          <div class="kv"><span>Chats</span><span>${state.chats.length}</span></div>
          <p class="muted" style="font-size:13px;line-height:1.55;margin:12px 0 14px">Rimo sucht Modelle auf Hugging Face und lädt sie über Ollama. Chats und Einstellungen bleiben auf deinem PC.</p>
          <button class="btn" data-action="open-folder" data-which="data">${icon('folder', 16)} Daten-Ordner</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ---- status -----------------------------------------------------------------

async function refreshStatus() {
  try {
    state.sys = await call('sys:info');
  } catch { return; }
  const ok = !!state.sys.ollamaVersion;
  const changed = ok !== state.ollamaOk;
  state.ollamaOk = ok;
  const el = $('#ollama-status');
  el.className = `status ${ok ? 'ok' : 'bad'}`;
  el.innerHTML = ok ? `<span class="dot"></span><span>Ollama ${esc(state.sys.ollamaVersion)} läuft</span>`
    : `<span class="dot"></span><span>Ollama aus</span><button data-action="start-ollama">Starten</button>`;
  const s = state.sys;
  $('#hw').innerHTML = s.vram ? `<b>${esc(s.gpuName || 'Grafikkarte')}</b>${fmtGiB(s.vram)} VRAM · ${fmtGiB(s.ram)} RAM` : `<b>Keine GPU erkannt</b>${fmtGiB(s.ram)} RAM`;
  if (changed && ok) loadModels();
  if (state.view === 'settings') render();
}

// ---- events -----------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const link = e.target.closest('[data-href]');
  if (link) {
    e.preventDefault();
    return attempt(() => call('open:external', link.dataset.href), 'Link');
  }
  const copy = e.target.closest('.code-copy');
  if (copy) {
    await navigator.clipboard.writeText(copy.closest('.code').querySelector('code').textContent);
    copy.textContent = 'Kopiert ✓';
    return setTimeout(() => { copy.textContent = 'Kopieren'; }, 1500);
  }
  const nav = e.target.closest('.nav-item');
  if (nav) return go(nav.dataset.view);
  const a = e.target.closest('[data-action]');
  if (!a || a.tagName === 'FORM') return;
  const { action, name, id } = a.dataset;
  switch (action) {
    case 'nav': return go(a.dataset.view);
    case 'sort': state.discover.sort = a.dataset.sort; return runSearch();
    case 'more': return runSearch(true);
    case 'open-model': return openModel(id);
    case 'back': state.detail = null; render(); return state.discover.loaded || runSearch();
    case 'readme': state.detail.readmeOpen = !state.detail.readmeOpen; return render();
    case 'pull': return startPull(name, a.dataset.label, a.dataset.level);
    case 'pull-cancel': return call('pull:cancel', name);
    case 'pull-dismiss': await call('pull:dismiss', name); state.pulls.delete(name); return render();
    case 'chat-with': return chatWith(name);
    case 'model-settings': return openModelSettings(name);
    case 'model-delete': return deleteModel(name);
    case 'open-folder': return call('open:folder', a.dataset.which);
    case 'start-ollama':
      await call('ollama:start');
      toast('Ollama wird gestartet …');
      return setTimeout(refreshStatus, 3000);
    case 'new-chat': return newChat();
    case 'open-chat': if (e.target.closest('.ci-del, .ci-ren')) return; return openChat(id);
    case 'rename-chat': return renameChat(id);
    case 'delete-chat': return deleteChat(id);
    case 'send': return sendMessage($('#composer').value);
    case 'stop': return stopStreaming();
    case 'suggest': return sendMessage(a.dataset.text);
    case 'regenerate': {
      if (state.streaming || !state.chat) return;
      const last = state.chat.messages[state.chat.messages.length - 1];
      if (last && last.role === 'assistant') state.chat.messages.pop();
      return generate(state.chat);
    }
    case 'copy-msg': {
      const m = state.chat.messages[Number(a.dataset.mid)];
      await navigator.clipboard.writeText(splitThink(m).content);
      return toast('Kopiert');
    }
    default:
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.action === 'search-form') return submitSearch($('#q').value);
  if (form.dataset.action === 'pull-form') {
    const name = $('#pull-name').value.trim();
    if (!name) return;
    $('#pull-name').value = '';
    return startPull(name, name);
  }
  if (form.dataset.action === 'save-defaults') {
    state.settings = await attempt(() => call('settings:set', { defaults: {
      system: $('#st-system').value, temperature: Number($('#st-temp').value), num_ctx: Number($('#st-ctx').value), think: $('#st-think').checked,
    } }));
    if (state.settings) toast('Gespeichert', 'ok');
    state.settings = state.settings || await call('settings:get');
  }
  if (form.dataset.action === 'save-ollama') {
    const res = await attempt(() => call('settings:set', { ollamaUrl: $('#st-url').value.trim(), vramOverrideGB: Number($('#st-vram').value) || 0 }));
    if (res) {
      state.settings = res;
      toast('Gespeichert', 'ok');
      refreshStatus();
      loadModels();
    }
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'model-select') {
    const name = e.target.value;
    state.pendingModel = name;
    if (state.chat && !state.streaming) {
      state.chat.model = name;
      if (state.chat.messages.length) saveChat(state.chat);
    }
    state.settings = await attempt(() => call('settings:set', { lastModel: name })) || state.settings;
    render();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'composer') autoGrow(e.target);
  if (e.target.id === 'st-temp') $('#st-temp-out').textContent = Number(e.target.value).toFixed(2);
});

// remember which thinking blocks the user opened, so streaming re-renders keep them open
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.dataset || d.dataset.think === undefined || !state.chat) return;
  const m = state.chat.messages[Number(d.dataset.think)];
  if (m && !(m.pending && !splitThink(m).content)) m.thinkOpen = d.open;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'composer' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.streaming) sendMessage(e.target.value);
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    state.detail = null;
    go('discover');
    setTimeout(() => $('#q') && $('#q').focus(), 0);
  }
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  if (e.key === 'Escape' && state.streaming) stopStreaming();
});

window.rimo.onEvent((ev) => {
  if (ev.type === 'pull') onPull(ev.pull);
  else if (ev.type === 'chat') onChat(ev);
  else if (ev.type === 'models-changed') loadModels();
});

// ---- start ------------------------------------------------------------------

(async function init() {
  state.settings = await call('settings:get');
  state.pendingModel = state.settings.lastModel;
  for (const p of await call('pull:list')) state.pulls.set(p.name, p);
  go('discover');
  refreshStatus();
  loadModels();
  call('chats:list').then((c) => { state.chats = c; });
  setInterval(refreshStatus, 10000);
})();

// hooks for the screenshot script (tools/shot.js)
window.rimoUI = { go, openModel, chatWith, sendMessage, openModelSettings, submitSearch, state };

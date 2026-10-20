// Rimo desktop app: search Hugging Face, download GGUF models through Ollama and chat with them.
// Everything talks over Electron IPC; Rimo opens no port of its own.
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const hf = require('./src/hf');
const { createOllama } = require('./src/ollama');
const { createStore } = require('./src/store');
const system = require('./src/system');
const { estimate, recommend, parseParamSize, GIB } = require('./src/fit');
const { bitsOf } = require('./src/quant');

const TEST = !!process.env.RIMO_TEST;
if (!TEST && !app.requestSingleInstanceLock()) app.quit();

let win = null;
let store = null;
const ollama = createOllama(() => store.getSettings().ollamaUrl);
const pulls = new Map(); // model name -> pull state
const chats = new Map(); // stream id -> AbortController
const capsCache = new Map();

let resolveWindow;
const windowReady = new Promise((r) => { resolveWindow = r; });

function send(event) {
  if (win && !win.isDestroyed()) win.webContents.send('rimo:event', event);
}

async function hardware() {
  const gpu = await system.detectGpu();
  const s = store.getSettings();
  const vram = s.vramOverrideGB > 0 ? s.vramOverrideGB * GIB : gpu.vram;
  return { gpuName: gpu.name, detectedVram: gpu.vram, vram, ram: system.totalRam() };
}

// ---- models -------------------------------------------------------------

function displayName(name) {
  const m = /^(?:hf\.co|huggingface\.co)\/([^/]+)\/([^:]+)(?::(.+))?$/i.exec(name);
  if (m) return { title: m[2].replace(/[-_]GGUF$/i, ''), author: m[1], tag: m[3] || 'latest', source: 'hf' };
  const [base, tag] = name.split(':');
  const parts = base.split('/');
  return { title: parts.pop(), author: parts.pop() || 'Ollama', tag: tag || 'latest', source: 'ollama' };
}

function archFromInfo(mi) {
  const a = mi['general.architecture'];
  const pick = (k) => {
    const v = mi[`${a}.${k}`];
    return Array.isArray(v) ? Math.max(...v) : v;
  };
  const heads = pick('attention.head_count');
  const emb = pick('embedding_length');
  return {
    layers: pick('block_count') || null,
    kvHeads: pick('attention.head_count_kv') || heads || null,
    headDim: pick('attention.key_length') || (emb && heads ? emb / heads : null),
    ctxMax: pick('context_length') || null,
    params: mi['general.parameter_count'] || null,
  };
}

async function capabilities(name) {
  if (!capsCache.has(name)) {
    const info = await ollama.show(name);
    capsCache.set(name, info.capabilities || []);
  }
  return capsCache.get(name);
}

async function listModels() {
  const [{ models }, ps, hw] = await Promise.all([ollama.tags(), ollama.ps().catch(() => ({ models: [] })), hardware()]);
  const loaded = new Map((ps.models || []).map((m) => [m.name, m]));
  return models.map((m) => {
    const d = m.details || {};
    const ctx = store.modelSettings(m.name).num_ctx;
    const fit = estimate({ fileBytes: m.size, params: parseParamSize(d.parameter_size), bits: bitsOf(d.quantization_level), ctx, vram: hw.vram, ram: hw.ram });
    const l = loaded.get(m.name);
    return {
      name: m.name,
      ...displayName(m.name),
      size: m.size,
      params: d.parameter_size || null,
      quant: d.quantization_level || null,
      family: d.family || null,
      ctxMax: d.context_length || null,
      capabilities: m.capabilities || null,
      modified: m.modified_at,
      loaded: l ? { size: l.size, vram: l.size_vram, expires: l.expires_at } : null,
      fit,
    };
  }).sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

// Details for the per-model settings: capabilities, max context and the VRAM need per context size.
async function modelInfo(name) {
  const [info, { models }, hw] = await Promise.all([ollama.show(name), ollama.tags(), hardware()]);
  capsCache.set(name, info.capabilities || []);
  const arch = archFromInfo(info.model_info || {});
  const tag = models.find((m) => m.name === name);
  const size = tag ? tag.size : 0;
  const ctxMax = arch.ctxMax || (tag && tag.details && tag.details.context_length) || 8192;
  const sizes = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144].filter((c) => c <= ctxMax);
  if (!sizes.includes(ctxMax) && ctxMax < 262144) sizes.push(ctxMax);
  const fits = sizes.map((ctx) => ({ ctx, ...estimate({ fileBytes: size, params: arch.params, ctx, arch, vram: hw.vram, ram: hw.ram }) }));
  return { name, ...displayName(name), capabilities: info.capabilities || [], ctxMax, size, fits, settings: store.modelSettings(name), hasOwn: !!store.getSettings().models[name] };
}

// ---- downloads ----------------------------------------------------------

function pullView(p) {
  const layers = [...p.layers.values()];
  const total = layers.reduce((s, l) => s + l.total, 0);
  const completed = layers.reduce((s, l) => s + l.completed, 0);
  return { name: p.name, label: p.label, status: p.status, total, completed, speed: p.speed, error: p.error, done: p.done, startedAt: p.startedAt };
}

function startPull(name, label) {
  const existing = pulls.get(name);
  if (existing && !existing.done) return pullView(existing);
  const p = { name, label: label || name, status: 'Starte …', layers: new Map(), speed: 0, error: null, done: false, startedAt: Date.now(), abort: new AbortController() };
  pulls.set(name, p);
  let lastSent = 0;
  let lastBytes = 0;
  let lastTime = Date.now();
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastSent < 200) return;
    lastSent = now;
    const v = pullView(p);
    const dt = (now - lastTime) / 1000;
    if (dt >= 0.8) {
      const rate = Math.max(0, (v.completed - lastBytes) / dt);
      p.speed = p.speed ? p.speed * 0.6 + rate * 0.4 : rate;
      lastBytes = v.completed;
      lastTime = now;
    }
    send({ type: 'pull', pull: pullView(p) });
  };
  ollama.pull(name, (line) => {
    p.status = statusText(line.status);
    if (line.digest && line.total) {
      p.layers.set(line.digest, { total: line.total, completed: line.completed || 0 });
    }
    emit(false);
  }, p.abort.signal).then(() => {
    p.done = true;
    p.status = 'Fertig';
    capsCache.delete(name);
    emit(true);
    send({ type: 'models-changed' });
  }).catch((err) => {
    p.done = true;
    p.error = err.name === 'AbortError' ? 'Abgebrochen' : friendlyPullError(err.message);
    p.status = p.error;
    emit(true);
  });
  emit(true);
  return pullView(p);
}

function statusText(s = '') {
  if (s === 'pulling manifest') return 'Hole Manifest …';
  if (s.startsWith('pulling')) return 'Lade herunter …';
  if (s === 'verifying sha256 digest') return 'Prüfe Datei …';
  if (s === 'writing manifest') return 'Speichere …';
  if (s === 'success') return 'Fertig';
  return s;
}

function friendlyPullError(msg) {
  if (/401|403|gated|access/i.test(msg)) return 'Kein Zugriff: Das Modell ist zugriffsbeschränkt. Du musst die Bedingungen auf Hugging Face akzeptieren und deinen Ollama-Schlüssel dort hinterlegen.';
  if (/not found|404|manifest unknown/i.test(msg)) return 'Datei nicht gefunden. Das Repo hat diese Quantisierung nicht (mehr).';
  if (/space|disk/i.test(msg)) return 'Zu wenig Speicherplatz auf der Festplatte.';
  return msg;
}

// ---- chat ---------------------------------------------------------------

async function startChat({ streamId, model, messages }) {
  const s = store.modelSettings(model);
  const caps = await capabilities(model).catch(() => []);
  const body = {
    model,
    messages: [...(s.system ? [{ role: 'system', content: s.system }] : []), ...messages.map((m) => ({ role: m.role, content: m.content }))],
    options: { temperature: Number(s.temperature), num_ctx: Number(s.num_ctx) },
  };
  if (caps.includes('thinking')) body.think = !!s.think;
  const ctrl = new AbortController();
  chats.set(streamId, ctrl);
  ollama.chat(body, (chunk) => {
    const msg = chunk.message || {};
    if (msg.content || msg.thinking) send({ type: 'chat', streamId, delta: msg.content || '', thinking: msg.thinking || '' });
    if (chunk.done) {
      send({ type: 'chat', streamId, done: true, stats: {
        evalCount: chunk.eval_count, evalDuration: chunk.eval_duration, promptCount: chunk.prompt_eval_count,
        loadDuration: chunk.load_duration, totalDuration: chunk.total_duration, doneReason: chunk.done_reason,
      } });
    }
  }, ctrl.signal).catch((err) => {
    if (err.name === 'AbortError') send({ type: 'chat', streamId, done: true, aborted: true });
    else send({ type: 'chat', streamId, error: err.message });
  }).finally(() => chats.delete(streamId));
  return { ok: true };
}

// ---- IPC ----------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('sys:info', async () => {
    const hw = await hardware();
    let ollamaVersion = null;
    try { ollamaVersion = (await ollama.version()).version; } catch { /* not running */ }
    return { ...hw, ollamaVersion, ollamaInstalled: !!system.ollamaExe(), appVersion: require('./package.json').version, modelsDir: system.modelsDir(), dataDir: app.getPath('userData') };
  });
  handle('ollama:start', () => {
    if (!system.startOllama()) shell.openExternal('https://ollama.com/download');
    return true;
  });

  handle('hf:search', (q) => hf.search(q || {}));
  handle('hf:parse', (input) => hf.parseRepo(input));
  handle('hf:model', async (id) => {
    const [m, hw, installed] = await Promise.all([hf.model(id), hardware(), ollama.tags().then((t) => t.models).catch(() => [])]);
    const ctx = store.getSettings().defaults.num_ctx;
    const opts = { params: m.params, ctx, vram: hw.vram, ram: hw.ram };
    const names = new Map(installed.map((x) => [x.name.toLowerCase(), x.name]));
    for (const v of m.variants) {
      v.ollamaName = `hf.co/${m.id}:${v.tag}`;
      v.installed = names.get(v.ollamaName.toLowerCase()) || null;
      v.fit = estimate({ ...opts, fileBytes: v.size, bits: v.bits });
    }
    m.recommended = recommend(m.variants, opts);
    m.hardware = { ...hw, ctx };
    return m;
  });

  handle('models:list', listModels);
  handle('models:info', modelInfo);
  handle('models:delete', async (name) => {
    await ollama.remove(name);
    capsCache.delete(name);
    store.setSettings({ models: { [name]: null } });
    return true;
  });

  handle('pull:start', ({ name, label }) => startPull(String(name).trim(), label));
  handle('pull:cancel', (name) => {
    const p = pulls.get(name);
    if (p && !p.done) p.abort.abort();
    return true;
  });
  handle('pull:list', () => [...pulls.values()].map(pullView));
  handle('pull:dismiss', (name) => {
    const p = pulls.get(name);
    if (p && p.done) pulls.delete(name);
    return true;
  });

  handle('chat:send', startChat);
  handle('chat:stop', (streamId) => {
    const c = chats.get(streamId);
    if (c) c.abort();
    return true;
  });

  handle('chats:list', () => store.listChats());
  handle('chats:get', (id) => store.getChat(id));
  handle('chats:save', (chat) => store.saveChat(chat));
  handle('chats:delete', (id) => store.deleteChat(id));

  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => {
    if (patch.ollamaUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(patch.ollamaUrl)) throw new Error('Die Ollama-Adresse muss mit http:// oder https:// beginnen.');
    return store.setSettings(patch);
  });

  handle('open:external', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Nur https-Links werden geöffnet.');
    return shell.openExternal(url);
  });
  handle('open:folder', (which) => shell.openPath(which === 'models' ? system.modelsDir() : app.getPath('userData')));
}

// ---- window -------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Rimo',
    backgroundColor: '#f4f7fd',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f4f7fd', symbolColor: '#1e3a8a', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: !TEST },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.once('ready-to-show', () => {
    if (TEST) {
      // screenshot runs: a visible but off-screen window keeps animations and painting going
      win.setPosition(-4000, 0);
      win.showInactive();
    } else {
      win.show();
    }
    resolveWindow(win);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  for (const p of pulls.values()) if (!p.done) p.abort.abort();
  app.quit();
});

module.exports = { windowReady };

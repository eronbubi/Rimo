// Chats (one JSON file each) and settings, stored in the app's user data folder.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  vramOverrideGB: 0,
  lastModel: null,
  defaults: { system: '', temperature: 0.7, num_ctx: 4096, think: true },
  models: {},
};

function createStore(dir) {
  const chatDir = path.join(dir, 'chats');
  const settingsFile = path.join(dir, 'settings.json');
  fs.mkdirSync(chatDir, { recursive: true });

  function writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  const chatFile = (id) => {
    if (!/^[\w-]+$/.test(id)) throw new Error('Ungültige Chat-ID');
    return path.join(chatDir, id + '.json');
  };

  function getSettings() {
    const s = readJson(settingsFile) || {};
    return { ...DEFAULTS, ...s, defaults: { ...DEFAULTS.defaults, ...s.defaults }, models: { ...s.models } };
  }

  function setSettings(patch) {
    const s = getSettings();
    const next = { ...s, ...patch };
    if (patch.defaults) next.defaults = { ...s.defaults, ...patch.defaults };
    if (patch.models) {
      next.models = { ...s.models };
      for (const [name, value] of Object.entries(patch.models)) {
        if (value === null) delete next.models[name];
        else next.models[name] = value;
      }
    }
    writeJson(settingsFile, next);
    return next;
  }

  // Settings that apply to one model: its own values on top of the global defaults.
  function modelSettings(name) {
    const s = getSettings();
    return { ...s.defaults, ...(s.models[name] || {}) };
  }

  function listChats() {
    return fs.readdirSync(chatDir).filter((f) => f.endsWith('.json')).map((f) => {
      const c = readJson(path.join(chatDir, f));
      if (!c) return null;
      const last = c.messages[c.messages.length - 1];
      return { id: c.id, title: c.title, model: c.model, updatedAt: c.updatedAt, preview: last ? last.content.slice(0, 80) : '' };
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return {
    getSettings,
    setSettings,
    modelSettings,
    listChats,
    getChat: (id) => readJson(chatFile(id)),
    saveChat: (chat) => { writeJson(chatFile(chat.id), chat); return true; },
    deleteChat: (id) => { fs.rmSync(chatFile(id), { force: true }); return true; },
  };
}

module.exports = { createStore, DEFAULTS };

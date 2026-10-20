// Exposes a small, fixed API to the page. Every call returns the data or throws the error text.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'sys:info', 'ollama:start',
  'hf:search', 'hf:parse', 'hf:model',
  'models:list', 'models:info', 'models:delete',
  'pull:start', 'pull:cancel', 'pull:list', 'pull:dismiss',
  'chat:send', 'chat:stop',
  'chats:list', 'chats:get', 'chats:save', 'chats:delete',
  'settings:get', 'settings:set',
  'open:external', 'open:folder',
];

contextBridge.exposeInMainWorld('rimo', {
  call: async (channel, arg) => {
    if (!CHANNELS.includes(channel)) throw new Error('Unbekannter Kanal: ' + channel);
    const res = await ipcRenderer.invoke(channel, arg);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  onEvent: (fn) => ipcRenderer.on('rimo:event', (_e, ev) => fn(ev)),
});

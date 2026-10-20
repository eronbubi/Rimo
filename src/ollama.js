// Thin client for the local Ollama API (pull, list, delete, chat). Rimo itself runs no server.
class OllamaError extends Error {}

function createOllama(getBase) {
  const base = () => getBase().replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, signal, timeout = 15000 } = {}) {
    let res;
    try {
      res = await fetch(base() + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal || AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new OllamaError('Ollama ist nicht erreichbar. Läuft Ollama?');
    }
    if (!res.ok) {
      let msg = `Ollama-Fehler ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* no JSON body */ }
      throw new OllamaError(msg);
    }
    return res;
  }

  async function json(path, opts) {
    return (await request(path, opts)).json();
  }

  // Reads a newline-delimited JSON stream and calls onLine for every object.
  async function stream(path, body, onLine, signal) {
    const res = await request(path, { method: 'POST', body, signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        if (obj.error) throw new OllamaError(obj.error);
        onLine(obj);
      }
    }
    if (buf.trim()) {
      const obj = JSON.parse(buf);
      if (obj.error) throw new OllamaError(obj.error);
      onLine(obj);
    }
  }

  return {
    version: () => json('/api/version', { timeout: 3000 }),
    tags: () => json('/api/tags'),
    ps: () => json('/api/ps'),
    show: (model) => json('/api/show', { method: 'POST', body: { model } }),
    remove: (model) => request('/api/delete', { method: 'DELETE', body: { model } }),
    pull: (model, onProgress, signal) => stream('/api/pull', { model, stream: true }, onProgress, signal),
    chat: (body, onChunk, signal) => stream('/api/chat', { ...body, stream: true }, onChunk, signal),
  };
}

module.exports = { createOllama, OllamaError };

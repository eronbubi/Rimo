// Hardware info for the VRAM check, and helpers to find or start Ollama.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let gpuCache = null;

function detectGpu() {
  if (gpuCache) return Promise.resolve(gpuCache);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true }, (err, out) => {
      if (err) return resolve((gpuCache = { name: null, vram: 0 }));
      const gpus = out.trim().split(/\r?\n/).map((l) => {
        const [name, mib] = l.split(',').map((s) => s.trim());
        return { name, vram: Number(mib) * 1024 * 1024 };
      }).filter((g) => g.vram > 0);
      gpus.sort((a, b) => b.vram - a.vram);
      resolve((gpuCache = gpus[0] || { name: null, vram: 0 }));
    });
  });
}

function ollamaExe() {
  const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama');
  for (const name of ['ollama app.exe', 'ollama.exe']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Starts the user's own Ollama tray app (it brings up the Ollama service).
function startOllama() {
  const exe = ollamaExe();
  if (!exe) return false;
  const args = exe.endsWith('ollama.exe') ? ['serve'] : [];
  spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

function modelsDir() {
  return process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
}

module.exports = { detectGpu, startOllama, ollamaExe, modelsDir, totalRam: () => os.totalmem() };

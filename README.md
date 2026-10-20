# Rimo

Desktop app for Windows that finds GGUF models on Hugging Face, downloads them through [Ollama](https://ollama.com) and lets you chat with them locally. The interface is in German.

## Features

- Search every Hugging Face repo that contains GGUF files, sort by popularity, trend, likes or date, or paste `author/model` / a Hugging Face link
- For each quantisation (Q2 … F16): size, quality and whether it fits your GPU's VRAM, plus a recommendation for your PC
- Downloads with progress, speed, remaining time and cancel
- Installed models with VRAM check, loaded state and delete
- Chat with saved history, live streaming, Markdown and code blocks, collapsible reasoning for thinking models (e.g. Qwen3)
- Per-model settings: system prompt, temperature, context length (with VRAM estimate), thinking on/off

Rimo runs no server of its own; the UI talks to the Electron main process over IPC, and the main process talks to Ollama.

## Requirements

- Windows, Node.js 20+
- [Ollama](https://ollama.com/download) installed and running (default `http://127.0.0.1:11434`)
- An NVIDIA GPU is detected via `nvidia-smi` for the VRAM check; without one, the VRAM value can be set by hand

## Run and build

```bash
npm install
npm run app      # start unpackaged
npm test         # unit tests
npm run dist     # builds dist/Rimo-win32-x64/Rimo.exe
```

`npx electron tools/shot.js <dir>` runs a screenshot tour of the UI in an off-screen window with its own data folder (`RIMO_SHOT_MODEL=<ollama model>` adds a chat).

## Limits

Only GGUF repos are listed. Models published only as safetensors/PyTorch, non-chat GGUFs (image, audio), architectures Ollama does not support yet and gated repos without your Ollama key on Hugging Face will not work.

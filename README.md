# Ustadh Noor — Karbala Guide

A voice-based Islamic education chatbot that helps children (ages 6–14) learn
about Karbala, Imam Hussain (AS), Muharram, and Azadari. Built with React + Vite.
KAZ School & Welfare.

The app listens to a spoken question (Web Speech API), sends it to Claude, and
speaks the answer back with an animated audio visualizer.

## Prerequisites

- **Node.js 18+** (this project was set up on Node 22)
- An **Anthropic API key** — https://console.anthropic.com/settings/keys
- A **Chromium-based browser** (Chrome or Edge) — voice input uses the Web
  Speech `SpeechRecognition` API, which Firefox/Safari don't fully support.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Add your API key
cp .env.example .env       # on Windows PowerShell: copy .env.example .env
# then edit .env and paste your Anthropic key

# 3. Start the dev server
npm run dev
```

Open the URL Vite prints (default http://localhost:5173). Tap the microphone and
ask a question, or tap **Questions** for suggested prompts.

## How it works

```
Browser (React)  ──POST /api/chat──►  Vite dev-server proxy  ──►  Anthropic API
   (no API key)                        (injects ANTHROPIC_API_KEY)
```

- `src/KarbalaChatbot.jsx` — the UI component (voice in, Claude, voice out).
- `vite.config.js` — a small middleware that proxies `/api/chat` to Anthropic so
  the **API key stays on the server** and is never shipped to the browser. It
  also avoids the CORS block that prevents calling Anthropic directly from a page.

The proxy pins the model to `claude-opus-4-8`. To change it, edit the `MODEL`
constant near the top of `vite.config.js`.

## Build for production

```bash
npm run build     # outputs to dist/
npm run preview   # serves dist/ with the same /api/chat proxy
```

> **Note:** `npm run preview` is for local verification only. For a real
> deployment you'd host `dist/` on static hosting and move the `/api/chat` proxy
> to a small server or serverless function (so the API key stays server-side).

## Notes / limitations

- Microphone access requires `localhost` or HTTPS, and you must grant the
  permission prompt.
- Voice recognition and the chosen speech-synthesis voice depend on the
  browser/OS; results vary across machines.

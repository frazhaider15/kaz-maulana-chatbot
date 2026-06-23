# Ustadh Noor — Karbala Guide

A voice-based Islamic education chatbot that helps children (ages 6–14) learn
about Karbala, Imam Hussain (AS), Muharram, and Azadari. Built with React + Vite.
KAZ School & Welfare.

The app listens to a spoken question (Web Speech API), sends it to Claude, and
speaks the answer back through ElevenLabs with an animated audio visualizer.

## Prerequisites

- **Node.js 18+** (this project was set up on Node 22)
- An **Anthropic API key** — https://console.anthropic.com/settings/keys
- An **ElevenLabs API key** — https://elevenlabs.io/app/settings/api-keys
- A **Chromium-based browser** (Chrome or Edge) — voice input uses the Web
  Speech `SpeechRecognition` API, which Firefox/Safari don't fully support.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Add your API keys
cp .env.example .env       # on Windows PowerShell: copy .env.example .env
# then edit .env and paste your Anthropic + ElevenLabs keys

# 3. Start the dev server
npm run dev
```

Open the URL Vite prints (default http://localhost:5173). Tap the microphone and
ask a question, or tap **Questions** for suggested prompts.

## How it works

```
Browser (React)  ──POST /api/chat──►  Vite dev-server proxy  ──►  Anthropic API
   (no API key)                        (injects ANTHROPIC_API_KEY)

Browser (React)  ──POST /api/tts ──►  Vite dev-server proxy  ──►  ElevenLabs API
  (no API key)                        (injects ELEVENLABS_API_KEY)
```

- `src/KarbalaChatbot.jsx` — the UI component (voice in, Claude, voice out).
- `vite.config.js` — a small middleware that proxies `/api/chat` to Anthropic so
  the **API key stays on the server** and is never shipped to the browser. It
  also avoids the CORS block that prevents calling Anthropic directly from a page.
  It also proxies `/api/tts` to ElevenLabs for voice output.

The proxy pins the model to `claude-sonnet-4-6`. To change it, edit the `MODEL`
constant near the top of `vite.config.js`.

For voice output, the app uses ElevenLabs via `/api/tts`. The default voice is
the built-in premade voice `pqHfZKP75CvOlQylNhV4` (Bill), and you can override
it by setting `ELEVENLABS_VOICE_ID` in `.env`.

## Build for production

```bash
npm run build     # outputs to dist/
npm run preview   # serves dist/ with the same /api/chat proxy
```

> **Note:** `npm run preview` is for local verification only. The `/api/chat`
> proxy in `vite.config.js` only runs locally — see deployment below for how it
> works in production.

## Deploying to Vercel

The local proxy in `vite.config.js` does **not** run on Vercel (Vercel serves the
static `dist/` build, with no Vite server). Instead, `api/chat.js` and
`api/tts.js` are **Vercel serverless functions** that do the same job in
production — Vercel automatically exposes any file in the root `api/` folder,
so they become `/api/chat` and `/api/tts`.

Two things are required for it to work:

1. **The `api/chat.js` and `api/tts.js` files must be deployed** (commit/push them, or redeploy).
2. **Set the API keys in Vercel:** Project → Settings → Environment Variables →
  add `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` (plus optional
  `ELEVENLABS_VOICE_ID`) for Production and Preview if you use it. Then
  **redeploy** — env-var changes only take effect on a new build.

Until the keys are set, the app shows
"ANTHROPIC_API_KEY is not set…" as its on-screen reply.

> Local dev (`vite.config.js` proxy) and production (`api/chat.js` function) share
> the same `MODEL`/`max_tokens` settings — if you change the model, update both.

## Notes / limitations

- Microphone access requires `localhost` or HTTPS, and you must grant the
  permission prompt.
- Voice recognition depends on the browser/OS; results vary across machines.
- Voice output now depends on ElevenLabs plus the `ELEVENLABS_API_KEY` setting.

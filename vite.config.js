import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

const ELEVENLABS_DEFAULT_VOICE_ID = "pqHfZKP75CvOlQylNhV4";
// eleven_flash_v2_5 is ElevenLabs' lowest-latency model; the lighter audio
// format means a faster first chunk when streaming. Both are env-overridable.
const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const ELEVENLABS_OUTPUT_FORMAT = "mp3_22050_32";
const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

/**
 * Tiny server-side proxy for the Anthropic Messages API.
 *
 * The browser POSTs { system, messages } to /api/chat. This middleware adds the
 * secret API key (read from .env, never shipped to the client) and forwards the
 * request to Anthropic. This avoids two problems with calling Anthropic directly
 * from the browser: (1) it would leak your API key, and (2) the API blocks
 * cross-origin browser requests.
 */
function anthropicProxy(apiKey) {
  const handle = async (req, res, next) => {
    if (req.method !== "POST" || !req.url.startsWith("/api/chat")) {
      return next();
    }

    if (!apiKey) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            message:
              "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key, then restart the dev server.",
          },
        })
      );
      return;
    }

    try {
      const body = await readJson(req);
      const upstream = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: body.system,
          messages: body.messages,
          // Stream tokens so the browser can speak the first sentence while the
          // rest of the answer is still being generated.
          stream: true,
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text();
        res.statusCode = upstream.status || 502;
        res.setHeader("Content-Type", "application/json");
        res.end(errText || JSON.stringify({ error: { message: "Chat request failed" } }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  };

  return {
    name: "anthropic-proxy",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

function elevenLabsProxy(apiKey, voiceId, modelId, outputFormat) {
  const handle = async (req, res, next) => {
    const isTts = req.url.startsWith("/api/tts");
    if (!isTts || (req.method !== "GET" && req.method !== "POST")) {
      return next();
    }

    if (!apiKey) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            message:
              "ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add your key, then restart the dev server.",
          },
        })
      );
      return;
    }

    try {
      // GET: text in the query string (browser <audio> streams it directly).
      // POST: text in the JSON body.
      let text;
      if (req.method === "GET") {
        text = (new URL(req.url, "http://localhost").searchParams.get("text") || "").toString();
      } else {
        const body = await readJson(req);
        text = (body.text || "").toString();
      }

      // /stream returns audio as it's generated; piping it through lets the
      // browser begin playback on the first chunk instead of the whole file.
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: ELEVENLABS_VOICE_SETTINGS,
          }),
        }
      );

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text();
        res.statusCode = upstream.status || 502;
        res.setHeader("Content-Type", "application/json");
        res.end(errText || JSON.stringify({ error: { message: "TTS request failed" } }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  };

  return {
    name: "elevenlabs-proxy",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export default defineConfig(({ mode }) => {
  // Load all env vars (including non-VITE_ prefixed) so the proxy can read the key.
  const env = loadEnv(mode, process.cwd(), "");
  const voiceId = env.ELEVENLABS_VOICE_ID || ELEVENLABS_DEFAULT_VOICE_ID;
  const modelId = env.ELEVENLABS_MODEL_ID || ELEVENLABS_MODEL_ID;
  const outputFormat = env.ELEVENLABS_OUTPUT_FORMAT || ELEVENLABS_OUTPUT_FORMAT;
  return {
    plugins: [
      react(),
      anthropicProxy(env.ANTHROPIC_API_KEY),
      elevenLabsProxy(env.ELEVENLABS_API_KEY, voiceId, modelId, outputFormat),
    ],
  };
});

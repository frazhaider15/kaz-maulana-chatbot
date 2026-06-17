import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

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
        }),
      });

      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", "application/json");
      res.end(text);
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
  return {
    plugins: [react(), anthropicProxy(env.ANTHROPIC_API_KEY)],
  };
});

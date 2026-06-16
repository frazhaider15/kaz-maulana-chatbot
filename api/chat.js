// Vercel Serverless Function — handles POST /api/chat in production.
//
// Vercel automatically exposes any file in this root `api/` folder as an
// endpoint, so this becomes https://<your-app>.vercel.app/api/chat.
//
// It mirrors the local dev proxy in vite.config.js: the browser POSTs
// { system, messages }, this function adds the secret ANTHROPIC_API_KEY (set in
// Vercel → Project Settings → Environment Variables) and forwards to Anthropic.
// The key never reaches the browser.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 1024;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: {
        message:
          "ANTHROPIC_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.",
      },
    });
    return;
  }

  try {
    // Vercel parses JSON bodies automatically when Content-Type is application/json.
    const { system, messages } = req.body || {};

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
        system,
        messages,
      }),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: { message: String(err) } });
  }
}

// Vercel Serverless Function — handles POST /api/tts in production.
//
// The browser POSTs { text } here, this function adds the secret
// ELEVENLABS_API_KEY (set in Vercel → Project Settings → Environment Variables)
// and returns MP3 audio. The key never reaches the browser.

import { Readable } from "node:stream";

const DEFAULT_VOICE_ID = "pqHfZKP75CvOlQylNhV4";
// eleven_flash_v2_5 is ElevenLabs' lowest-latency model (~75ms model latency).
// Swap to "eleven_turbo_v2_5" for more warmth, or "eleven_multilingual_v2" for
// max fidelity (slowest). Lighter audio format = faster first chunk when streaming.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_22050_32";
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

export default async function handler(req, res) {
  // GET lets the browser's <audio> element stream the endpoint directly (text
  // rides in the query string); POST is kept for programmatic callers.
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: {
        message:
          "ELEVENLABS_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.",
      },
    });
    return;
  }

  try {
    // Text comes from the query string (GET, native <audio> streaming) or the
    // JSON body (POST).
    const text = (req.query?.text ?? req.body?.text ?? "").toString();
    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

    // The /stream endpoint returns audio as it's generated; piping it straight
    // through lets the browser start playing the first words almost immediately.
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: VOICE_SETTINGS,
        }),
      }
    );

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      res.status(upstream.status || 502);
      res.setHeader("Content-Type", "application/json");
      res.send(errText || JSON.stringify({ error: { message: "TTS request failed" } }));
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    // Pipe ElevenLabs' chunked audio straight to the client (no full-buffer wait).
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(500).json({ error: { message: String(err) } });
  }
}
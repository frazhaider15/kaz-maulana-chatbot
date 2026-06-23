// Vercel Serverless Function — handles POST /api/tts in production.
//
// The browser POSTs { text } here, this function adds the secret
// ELEVENLABS_API_KEY (set in Vercel → Project Settings → Environment Variables)
// and returns MP3 audio. The key never reaches the browser.

const DEFAULT_VOICE_ID = "pqHfZKP75CvOlQylNhV4";
const MODEL_ID = "eleven_multilingual_v2";
const OUTPUT_FORMAT = "mp3_44100_128";
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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
    const { text } = req.body || {};
    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: (text || "").toString(),
          model_id: MODEL_ID,
          voice_settings: VOICE_SETTINGS,
        }),
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", "application/json");
      res.send(errText || JSON.stringify({ error: { message: "TTS request failed" } }));
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (err) {
    res.status(500).json({ error: { message: String(err) } });
  }
}
import { useState, useRef, useEffect } from "react";

const SCHOLAR_IMG = "/background.png";

const systemPrompt = `You are "Ustadh Noor" — a warm, gentle, and knowledgeable Islamic educator helping children (ages 6–14) learn about Karbala, Imam Hussain (AS), Muharram, and Azadari.
- Answer in simple, age-appropriate English (2–4 sentences max for voice)
- Be respectful — use (AS) for Imams, (SA) for ladies like Bibi Zainab
- Only answer about: Muharram, Karbala, Imam Hussain (AS), Azadari, companions, Ashura, Islamic history
- If off-topic kindly redirect: "That is a great question! I am here especially to help you learn about Karbala and Imam Hussain. What would you like to know?"
- Keep answers concise — they will be spoken aloud
- Speak warmly as if talking directly to a child in a classroom
- IMPORTANT: Your reply is read aloud by a voice. Write plain spoken sentences only. Do NOT use emojis, asterisks, markdown, bullet points, headings, or any special symbols.`;

const QUICK_QS = [
  "Who was Imam Hussain?",
  "What happened in Karbala?",
  "Who was Hazrat Abbas?",
  "What is Ashura?",
  "Who was Bibi Zainab?",
  "Who were the 72 companions?",
  "Why is Muharram important?",
  "Who was Hur ibn Yazid?",
];

// Audio visualizer bars count
const BAR_COUNT = 32;

// Strip emojis and markdown symbols so the voice doesn't read them aloud
// (e.g. "**Imam**" being spoken as "asterisk asterisk Imam"). Also used for the
// on-screen caption so it matches what's spoken.
function cleanForSpeech(text) {
  if (!text) return "";
  return text
    // Remove emoji / pictographic symbols, plus joiners (U+200D), variation
    // selectors (U+FE0F) and the combining enclosing keycap (U+20E3).
    .replace(/[\p{Extended_Pictographic}‍️⃣]/gu, "")
    // Remove markdown formatting characters: * _ ` ~ # > and leading list dashes.
    .replace(/[*_`~#>]/g, "")
    .replace(/^[ \t]*[-•]\s+/gm, "")
    // Collapse whitespace left behind.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split streamed text into complete sentences for incremental speaking. A
// sentence is only emitted once it's followed by whitespace, so we never cut a
// word mid-token as the stream trickles in. The trailing remainder is returned
// for the caller to keep accumulating.
function splitSentences(buf) {
  const sentences = [];
  const re = /[^.!?…]*[.!?…]+["')\]]*\s+/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(buf)) !== null) {
    sentences.push(buf.slice(lastIndex, re.lastIndex).trim());
    lastIndex = re.lastIndex;
  }
  return { sentences, rest: buf.slice(lastIndex) };
}

// Pull the text out of one Anthropic SSE event block. Returns "" for pings,
// message_delta, and other non-text events.
function parseSseTextDelta(rawEvent) {
  let data = "";
  for (const line of rawEvent.split("\n")) {
    const l = line.trimStart();
    if (l.startsWith("data:")) data += l.slice(5).trim();
  }
  if (!data || data === "[DONE]") return "";
  try {
    const json = JSON.parse(data);
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
      return json.delta.text || "";
    }
  } catch {
    // Non-JSON keepalive line — ignore.
  }
  return "";
}

// A ~20ms silent WAV. Playing it on each pooled <audio> element during a user
// gesture "unlocks" them so later sentence transitions can autoplay.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

export default function SoulMachinesKarbala() {
  const [phase, setPhase] = useState("idle"); // idle | listening | thinking | speaking
  const [transcript, setTranscript] = useState("");
  const [caption, setCaption] = useState("");
  const [question, setQuestion] = useState("");
  const [showQuick, setShowQuick] = useState(false);
  const [barHeights, setBarHeights] = useState(Array(BAR_COUNT).fill(4));
  const [error, setError] = useState("");
  const [breathScale, setBreathScale] = useState(1);

  const recRef = useRef(null);
  // Two pooled <audio> elements for gapless playback: while one speaks a
  // sentence, the next sentence preloads into the other.
  const audioPoolRef = useRef([]);
  const unlockedRef = useRef(false);
  const sendQuestionRef = useRef(null); // latest sendQuestion, for the rec callback
  const animFrameRef = useRef(null);
  const breathRef = useRef(null);
  // Mutable state for the in-progress spoken answer (refs, not React state, so
  // producing/consuming sentences doesn't trigger re-renders).
  const speechRef = useRef({
    seq: 0,            // bumped per answer; invalidates stale producers/consumers
    queue: [],         // cleaned sentences ready to speak, in order
    notify: null,      // resolve fn that wakes the consumer when a sentence lands
    streamDone: true,  // true once the producer (Claude stream) has finished
    sentenceBuf: "",   // streamed text not yet a complete sentence
    pendingChunk: "",  // complete sentences being batched before flushing
    spokeFirst: false, // has the first chunk been flushed yet (fast start)
  });

  // Breathing animation
  useEffect(() => {
    let t = 0;
    const animate = () => {
      t += 0.02;
      setBreathScale(1 + Math.sin(t) * 0.012);
      breathRef.current = requestAnimationFrame(animate);
    };
    breathRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(breathRef.current);
  }, []);

  // Audio bar animation
  useEffect(() => {
    const animateBars = () => {
      if (phase === "listening" || phase === "speaking") {
        setBarHeights(prev => prev.map((_, i) => {
          const base = phase === "speaking" ? 18 : 10;
          const variance = phase === "speaking" ? 28 : 18;
          return base + Math.random() * variance * Math.abs(Math.sin(Date.now() / 200 + i * 0.4));
        }));
      } else if (phase === "thinking") {
        setBarHeights(prev => prev.map((_, i) => {
          const wave = Math.sin(Date.now() / 300 + i * 0.5);
          return 6 + wave * 5;
        }));
      } else {
        setBarHeights(Array(BAR_COUNT).fill(4));
      }
      animFrameRef.current = requestAnimationFrame(animateBars);
    };
    animFrameRef.current = requestAnimationFrame(animateBars);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [phase]);

  // Init recognition
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setError("Voice requires Chrome or Edge browser."); return; }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.onstart = () => setPhase("listening");
    rec.onresult = e => {
      const t = Array.from(e.results).map(r => r[0].transcript).join("");
      setTranscript(t);
      if (e.results[e.results.length - 1].isFinal) { rec.stop(); sendQuestionRef.current?.(t); }
    };
    rec.onerror = e => { setError("Mic error: " + e.error); setPhase("idle"); };
    rec.onend = () => { if (phase === "listening") setPhase("idle"); };
    recRef.current = rec;
  }, []);

  // Two reusable <audio> elements (a playback pool). Created once and reused so
  // the page's audio stays "unlocked" after the first user gesture. Phase is set
  // by the consumer (not onplay), so the silent unlock clip doesn't flip it.
  useEffect(() => {
    const make = () => {
      const a = new Audio();
      a.preload = "auto";
      return a;
    };
    const pool = [make(), make()];
    audioPoolRef.current = pool;
    return () => pool.forEach((a) => { a.pause(); a.removeAttribute("src"); });
  }, []);

  const ttsUrl = (str) => `/api/tts?text=${encodeURIComponent(str)}`;

  // Prime both pooled elements within a user gesture (mic tap / quick question)
  // so later non-gesture sentence transitions are allowed to autoplay.
  function unlockAudioPool() {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    audioPoolRef.current.forEach((a) => {
      try {
        a.src = SILENT_WAV;
        const p = a.play();
        if (p?.then) p.then(() => { a.pause(); a.removeAttribute("src"); }).catch(() => {});
      } catch { /* ignore */ }
    });
  }

  // Cancel the current spoken answer: invalidate the producer/consumer (bump
  // seq), clear the queue, and stop both pooled elements.
  function stopAudio() {
    const sp = speechRef.current;
    sp.seq++;
    sp.queue = [];
    sp.streamDone = true;
    sp.sentenceBuf = "";
    sp.pendingChunk = "";
    sp.spokeFirst = false;
    if (sp.notify) { sp.notify(); sp.notify = null; }
    audioPoolRef.current.forEach((a) => { a.pause(); a.removeAttribute("src"); a.load(); });
    setPhase("idle");
  }

  // Start a fresh spoken answer and kick off the consumer loop (which waits for
  // sentences to be enqueued). Returns the seq token identifying this answer.
  function beginSpeechTurn() {
    stopAudio();                 // bump seq, clear any prior answer
    const sp = speechRef.current;
    sp.streamDone = false;
    const seq = sp.seq;
    consumeSpeech(seq);          // async; plays sentences as they arrive
    return seq;
  }

  // Queue one sentence for speaking and wake the consumer.
  function enqueueSpeech(sentence, seq) {
    const sp = speechRef.current;
    if (seq !== sp.seq) return;
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    sp.queue.push(clean);
    if (sp.notify) { sp.notify(); sp.notify = null; }
  }

  // Feed streamed text in. Whole sentences are extracted and batched; the first
  // chunk flushes immediately (fast first audio), later chunks once they reach a
  // comfortable length so playback stays smooth.
  function feedSpeech(textChunk, seq) {
    const sp = speechRef.current;
    if (seq !== sp.seq) return;
    sp.sentenceBuf += textChunk;
    const { sentences, rest } = splitSentences(sp.sentenceBuf);
    sp.sentenceBuf = rest;
    for (const sentence of sentences) {
      sp.pendingChunk = sp.pendingChunk ? `${sp.pendingChunk} ${sentence}` : sentence;
      if (!sp.spokeFirst || sp.pendingChunk.length >= 80) {
        enqueueSpeech(sp.pendingChunk, seq);
        sp.pendingChunk = "";
        sp.spokeFirst = true;
      }
    }
  }

  // No more text is coming: flush whatever's left and let the consumer drain.
  function endSpeech(seq) {
    const sp = speechRef.current;
    if (seq !== sp.seq) return;
    const tail = `${sp.pendingChunk} ${sp.sentenceBuf}`.trim();
    sp.pendingChunk = "";
    sp.sentenceBuf = "";
    if (tail) enqueueSpeech(tail, seq);
    sp.streamDone = true;
    if (sp.notify) { sp.notify(); sp.notify = null; }
  }

  // Resolve once the next sentence is available, or the turn ends/supersedes.
  function waitForSentence(seq) {
    return new Promise((resolve) => {
      const sp = speechRef.current;
      if (seq !== sp.seq || sp.queue.length || sp.streamDone) { resolve(); return; }
      sp.notify = resolve;
    });
  }

  // Pull the next sentence, waiting for the producer if needed. null = no more.
  async function takeSentence(seq) {
    const sp = speechRef.current;
    while (sp.queue.length === 0) {
      if (sp.streamDone || seq !== sp.seq) return null;
      await waitForSentence(seq);
      if (seq !== sp.seq) return null;
    }
    return sp.queue.shift();
  }

  // Play one clip; resolves when it ends, errors, or is interrupted (paused).
  function playClip(el, seq) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        el.onended = null; el.onerror = null; el.onpause = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.onpause = done; // fires when stopAudio() interrupts a playing clip
      if (seq !== speechRef.current.seq) { done(); return; }
      const p = el.play();
      if (p?.catch) p.catch(done);
    });
  }

  // Consumer loop: plays queued sentences back-to-back, preloading the next
  // sentence into the other pooled element so transitions are near-gapless.
  async function consumeSpeech(seq) {
    const sp = speechRef.current;
    const pool = audioPoolRef.current;
    if (pool.length < 2) return;
    let idx = 0;

    let current = await takeSentence(seq);
    if (current == null) { if (seq === sp.seq) setPhase("idle"); return; }
    if (seq === sp.seq) setPhase("speaking");
    pool[idx].src = ttsUrl(current);

    while (current != null && seq === sp.seq) {
      const playing = playClip(pool[idx], seq);
      const next = await takeSentence(seq);                 // wait for the next sentence
      if (next != null && seq === sp.seq) pool[1 - idx].src = ttsUrl(next); // preload it
      await playing;                                        // until current finishes
      current = next;
      idx = 1 - idx;
    }
    if (seq === sp.seq) { setPhase("idle"); setTranscript(""); }
  }

  // Ask a question: stream Claude's answer, show it as a live caption, and speak
  // it sentence-by-sentence as it arrives.
  async function sendQuestion(q) {
    if (!q.trim()) return;
    setQuestion(q);
    setCaption("");
    setTranscript("");
    setError("");

    const seq = beginSpeechTurn(); // stops anything playing, starts the consumer
    setPhase("thinking");

    let acc = "";
    try {
      // Calls our own dev-server proxy (see vite.config.js) / serverless function
      // (api/chat.js), which injects the Anthropic API key server-side and
      // streams Claude's response back as Server-Sent Events.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: "user", content: q }],
        }),
      });

      if (!res.ok || !res.body) {
        let msg = "I am sorry, please try again.";
        try { const d = await res.json(); if (d.error?.message) msg = d.error.message; } catch { /* not JSON */ }
        setCaption(msg);
        feedSpeech(msg, seq);
        endSpeech(seq);
        return;
      }

      // Read the SSE stream: accumulate text_delta tokens, update the caption
      // live, and hand each token to the speech pipeline.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const { value, done: rdDone } = await reader.read();
        if (rdDone) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const evt = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const token = parseSseTextDelta(evt);
          if (token) {
            acc += token;
            setCaption(cleanForSpeech(acc));
            feedSpeech(token, seq);
          }
          if (evt.includes('"type":"message_stop"')) done = true;
        }
      }

      if (!acc.trim()) {
        const msg = "I am sorry, please try again.";
        setCaption(msg);
        feedSpeech(msg, seq);
      }
      endSpeech(seq);
    } catch {
      setError("Connection failed. Please try again.");
      stopAudio();
    }
  }
  sendQuestionRef.current = sendQuestion;

  const toggleMic = () => {
    if (phase === "speaking") { stopAudio(); return; }
    if (phase === "listening") { recRef.current?.stop(); setPhase("idle"); return; }
    if (phase === "thinking") return;
    setError(""); setTranscript("");
    unlockAudioPool(); // within this tap, so spoken replies can autoplay later
    try { recRef.current?.start(); }
    catch { setError("Could not start mic — allow microphone access."); }
  };

  const isActive = phase !== "idle";
  const glowColor = phase === "listening" ? "#22c55e" : phase === "thinking" ? "#f59e0b" : phase === "speaking" ? "#60a5fa" : "#ffd700";

  return (
    <div style={s.root}>
      {/* Full-bleed scholar background */}
      <div style={{ ...s.bgPhoto, transform: `scale(${breathScale})` }}>
        <img src={SCHOLAR_IMG} alt="" style={s.bgImg} />
        <div style={s.bgGradient} />
        {/* Subtle vignette */}
        <div style={s.vignette} />
      </div>

      {/* Particle dots */}
      {Array.from({length: 20}).map((_, i) => (
        <div key={i} style={{
          position:"fixed", borderRadius:"50%",
          width: 2+i%3, height: 2+i%3,
          background: i%3===0 ? "#ffd700" : i%3===1 ? "#c0392b" : "#fff",
          left: `${(i*5.1)%100}%`, top: `${(i*7.3)%100}%`,
          opacity: 0.15 + (i%4)*0.07,
          animation: `float ${4+i%5}s ease-in-out ${i%4}s infinite`,
          pointerEvents:"none", zIndex:1,
        }}/>
      ))}

      {/* Top bar */}
      <div style={s.topBar}>
        <div style={s.topLeft}>
          <div style={s.logoMark}>🕌</div>
          <div>
            <div style={s.logoTitle}>Ustadh Noor</div>
            <div style={s.logoSub}>Karbala Guide · KAZ School & Welfare</div>
          </div>
        </div>
        <div style={{...s.statusPill, borderColor: glowColor + "66", boxShadow:`0 0 12px ${glowColor}33`}}>
          <div style={{...s.statusDot, background: glowColor, boxShadow:`0 0 6px ${glowColor}`}}/>
          <span style={{color: glowColor}}>
            {phase === "listening" ? "Listening" : phase === "thinking" ? "Thinking" : phase === "speaking" ? "Speaking" : "Ready"}
          </span>
        </div>
      </div>

      {/* Center — waveform visualizer */}
      <div style={s.visualizerWrap}>
        {/* Glow ring when active */}
        {isActive && (
          <div style={{...s.glowRing, borderColor: glowColor, boxShadow: `0 0 40px ${glowColor}55, inset 0 0 40px ${glowColor}11`}}/>
        )}
        {/* Audio bars */}
        <div style={s.barsContainer}>
          {barHeights.map((h, i) => (
            <div key={i} style={{
              width: 3,
              height: Math.max(3, h),
              borderRadius: 4,
              background: phase === "listening"
                ? `rgba(34,197,94,${0.4 + (i/BAR_COUNT)*0.6})`
                : phase === "speaking"
                ? `rgba(96,165,250,${0.4 + (i/BAR_COUNT)*0.6})`
                : phase === "thinking"
                ? `rgba(245,158,11,${0.5})`
                : `rgba(255,215,0,0.2)`,
              transition: "height 0.05s ease",
              transformOrigin: "bottom",
            }}/>
          ))}
        </div>
      </div>

      {/* Caption / transcript area */}
      <div style={s.captionArea}>
        {phase === "listening" && transcript && (
          <div style={{...s.transcriptBubble}}>
            <span style={s.transcriptText}>{transcript}</span>
          </div>
        )}
        {(phase === "speaking" || phase === "idle") && caption && (
          <div style={s.captionBubble}>
            <p style={s.captionText}>{caption}</p>
          </div>
        )}
        {phase === "thinking" && (
          <div style={s.thinkingRow}>
            {[0,1,2].map(i => <div key={i} style={{...s.thinkDot, animationDelay:`${i*0.2}s`}}/>)}
          </div>
        )}
        {error && <div style={s.errorMsg}>{error}</div>}
      </div>

      {/* Bottom controls */}
      <div style={s.bottomBar}>
        {/* Quick questions toggle */}
        <button style={s.secondaryBtn} onClick={() => setShowQuick(p => !p)}>
          <span style={{fontSize:18}}>💬</span>
          <span style={s.btnLabel}>Questions</span>
        </button>

        {/* Main mic button */}
        <button
          style={{
            ...s.micBtn,
            background: phase === "listening"
              ? "radial-gradient(circle, #16a34a, #15803d)"
              : phase === "speaking"
              ? "radial-gradient(circle, #2563eb, #1d4ed8)"
              : phase === "thinking"
              ? "radial-gradient(circle, #78350f, #92400e)"
              : "radial-gradient(circle, #9f1239, #881337)",
            boxShadow: isActive
              ? `0 0 0 3px ${glowColor}44, 0 0 40px ${glowColor}55, 0 8px 30px rgba(0,0,0,0.6)`
              : "0 0 0 2px rgba(255,215,0,0.3), 0 8px 30px rgba(0,0,0,0.5)",
            transform: phase === "listening" ? "scale(1.1)" : "scale(1)",
            cursor: phase === "thinking" ? "not-allowed" : "pointer",
          }}
          onClick={toggleMic}
          disabled={phase === "thinking"}
          aria-label="Toggle microphone"
        >
          {phase === "listening" ? (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          ) : phase === "speaking" ? (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" rx="2"/>
              <rect x="14" y="4" width="4" height="16" rx="2"/>
            </svg>
          ) : (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
              <path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round"/>
              <line x1="12" y1="19" x2="12" y2="23" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              <line x1="8" y1="23" x2="16" y2="23" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          )}
        </button>

        {/* Mute / settings placeholder */}
        <button style={s.secondaryBtn} onClick={() => { stopAudio(); setCaption(""); setQuestion(""); setTranscript(""); }}>
          <span style={{fontSize:18}}>🔄</span>
          <span style={s.btnLabel}>Reset</span>
        </button>
      </div>

      {/* Quick questions panel */}
      {showQuick && (
        <div style={s.quickPanel}>
          <div style={s.quickTitle}>Tap a question to ask</div>
          <div style={s.quickGrid}>
            {QUICK_QS.map((q, i) => (
              <button key={i} style={s.quickChip}
                onClick={() => { unlockAudioPool(); setShowQuick(false); sendQuestion(q); }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(159,18,57,0.9)"}
                onMouseLeave={e => e.currentTarget.style.background = "rgba(159,18,57,0.55)"}
              >{q}</button>
            ))}
          </div>
        </div>
      )}

      {/* Hint */}
      {phase === "idle" && !caption && (
        <div style={s.hintText}>
          Tap the microphone and ask a question about Imam Hussain (AS) or Karbala
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Amiri:wght@400;700&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        body { overflow:hidden; }
        @keyframes float {
          0%,100% { transform:translateY(0) scale(1); opacity:0.15; }
          50% { transform:translateY(-12px) scale(1.2); opacity:0.35; }
        }
        @keyframes pulseDot {
          0%,100% { transform:scale(1); opacity:1; }
          50% { transform:scale(1.6); opacity:0.7; }
        }
        @keyframes bounce {
          0%,80%,100% { transform:translateY(0); opacity:0.4; }
          40% { transform:translateY(-8px); opacity:1; }
        }
        @keyframes fadeUp {
          from { opacity:0; transform:translateY(12px); }
          to { opacity:1; transform:translateY(0); }
        }
        @keyframes ringPulse {
          0%,100% { opacity:0.6; transform:translate(-50%,-50%) scale(1); }
          50% { opacity:0.2; transform:translate(-50%,-50%) scale(1.05); }
        }
        button { border:none; cursor:pointer; font-family:inherit; }
      `}</style>
    </div>
  );
}

const s = {
  root: {
    position:"fixed", inset:0,
    background:"#000",
    fontFamily:"'Inter',sans-serif",
    overflow:"hidden",
    display:"flex", flexDirection:"column",
    alignItems:"center", justifyContent:"space-between",
    userSelect:"none",
  },
  bgPhoto: {
    position:"fixed", inset:"-5%",
    transition:"transform 0.1s ease",
    zIndex:0,
  },
  bgImg: {
    width:"100%", height:"100%",
    objectFit:"cover", objectPosition:"70% center",
    filter:"brightness(0.55) saturate(0.8)",
  },
  bgGradient: {
    position:"absolute", inset:0,
    background:"linear-gradient(to top, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.5) 40%, rgba(0,0,0,0.2) 70%, rgba(0,0,0,0.6) 100%)",
  },
  vignette: {
    position:"absolute", inset:0,
    background:"radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.7) 100%)",
  },
  topBar: {
    position:"relative", zIndex:10,
    width:"100%", display:"flex",
    justifyContent:"space-between", alignItems:"center",
    padding:"20px 28px 0",
  },
  topLeft: { display:"flex", alignItems:"center", gap:12 },
  logoMark: { fontSize:28, filter:"drop-shadow(0 0 8px rgba(255,215,0,0.5))" },
  logoTitle: {
    fontFamily:"'Amiri',serif", fontSize:20, fontWeight:700,
    color:"#ffd700", textShadow:"0 0 20px rgba(255,215,0,0.4)",
    lineHeight:1.2,
  },
  logoSub: { fontSize:11, color:"rgba(255,255,255,0.4)", letterSpacing:0.5 },
  statusPill: {
    display:"flex", alignItems:"center", gap:7,
    border:"1px solid", borderRadius:30,
    padding:"6px 14px",
    background:"rgba(0,0,0,0.5)",
    backdropFilter:"blur(12px)",
    fontSize:13, fontWeight:500,
    transition:"all 0.4s",
  },
  statusDot: {
    width:8, height:8, borderRadius:"50%",
    animation:"pulseDot 1.5s ease-in-out infinite",
  },
  visualizerWrap: {
    position:"relative", zIndex:10,
    display:"flex", alignItems:"center", justifyContent:"center",
    flex:1,
    width:"100%",
  },
  glowRing: {
    position:"absolute",
    width:260, height:260,
    borderRadius:"50%",
    border:"1.5px solid",
    top:"50%", left:"50%",
    transform:"translate(-50%,-50%)",
    animation:"ringPulse 2s ease-in-out infinite",
    pointerEvents:"none",
  },
  barsContainer: {
    display:"flex", alignItems:"flex-end",
    gap:3,
    height:80,
    padding:"0 20px",
  },
  captionArea: {
    position:"relative", zIndex:10,
    width:"100%", maxWidth:720,
    padding:"0 24px 8px",
    minHeight:100,
    display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
  },
  captionBubble: {
    background:"rgba(0,0,0,0.72)",
    border:"1px solid rgba(255,255,255,0.1)",
    borderRadius:18,
    padding:"14px 22px",
    backdropFilter:"blur(20px)",
    animation:"fadeUp 0.4s ease",
    width:"100%",
  },
  captionText: {
    color:"rgba(255,255,255,0.92)",
    fontSize:16, lineHeight:1.7,
    textAlign:"center",
    fontWeight:400,
  },
  transcriptBubble: {
    background:"rgba(34,197,94,0.12)",
    border:"1px solid rgba(34,197,94,0.3)",
    borderRadius:18, padding:"10px 20px",
    backdropFilter:"blur(12px)",
    animation:"fadeUp 0.2s ease",
  },
  transcriptText: { color:"rgba(200,255,200,0.9)", fontSize:15, fontStyle:"italic" },
  thinkingRow: {
    display:"flex", gap:8, alignItems:"center", height:40,
  },
  thinkDot: {
    width:10, height:10, borderRadius:"50%",
    background:"rgba(245,158,11,0.8)",
    animation:"bounce 1.2s ease-in-out infinite",
  },
  errorMsg: {
    color:"#fca5a5", fontSize:13, textAlign:"center",
    background:"rgba(220,38,38,0.15)", borderRadius:12,
    padding:"8px 16px", border:"1px solid rgba(220,38,38,0.3)",
  },
  bottomBar: {
    position:"relative", zIndex:10,
    width:"100%", display:"flex",
    justifyContent:"center", alignItems:"center",
    gap:32, padding:"12px 28px 28px",
  },
  micBtn: {
    width:80, height:80, borderRadius:"50%",
    display:"flex", alignItems:"center", justifyContent:"center",
    transition:"all 0.25s ease",
    flexShrink:0,
  },
  secondaryBtn: {
    display:"flex", flexDirection:"column", alignItems:"center", gap:4,
    background:"rgba(255,255,255,0.07)",
    border:"1px solid rgba(255,255,255,0.12)",
    borderRadius:14, padding:"10px 16px",
    color:"rgba(255,255,255,0.7)",
    backdropFilter:"blur(12px)",
    transition:"background 0.2s",
    minWidth:70,
  },
  btnLabel: { fontSize:11, fontWeight:500, letterSpacing:0.4 },
  quickPanel: {
    position:"fixed", bottom:110, left:"50%",
    transform:"translateX(-50%)",
    background:"rgba(5,0,0,0.92)",
    border:"1px solid rgba(139,0,0,0.5)",
    borderRadius:20, padding:"16px 20px",
    backdropFilter:"blur(24px)",
    width:"min(520px,95vw)", zIndex:20,
    animation:"fadeUp 0.2s ease",
    boxShadow:"0 -8px 40px rgba(0,0,0,0.6)",
  },
  quickTitle: {
    fontSize:11, fontWeight:600, letterSpacing:1,
    color:"rgba(255,215,0,0.5)", textTransform:"uppercase",
    marginBottom:12, textAlign:"center",
  },
  quickGrid: {
    display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center",
  },
  quickChip: {
    background:"rgba(159,18,57,0.55)",
    border:"1px solid rgba(255,100,100,0.2)",
    color:"rgba(255,220,180,0.9)",
    borderRadius:30, padding:"7px 14px",
    fontSize:13, fontWeight:500,
    transition:"background 0.2s",
    cursor:"pointer",
  },
  hintText: {
    position:"fixed", bottom:110, left:"50%",
    transform:"translateX(-50%)",
    color:"rgba(255,255,255,0.3)",
    fontSize:13, textAlign:"center",
    whiteSpace:"nowrap",
    zIndex:5, pointerEvents:"none",
    letterSpacing:0.3,
  },
};

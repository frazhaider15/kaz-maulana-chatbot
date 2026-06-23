import { useState, useRef, useEffect, useCallback } from "react";

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
  const audioRef = useRef(null);
  const urlRef = useRef(null);
  const ttsAbortRef = useRef(null);
  const animFrameRef = useRef(null);
  const breathRef = useRef(null);

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
      if (e.results[e.results.length - 1].isFinal) { rec.stop(); sendQuestion(t); }
    };
    rec.onerror = e => { setError("Mic error: " + e.error); setPhase("idle"); };
    rec.onend = () => { if (phase === "listening") setPhase("idle"); };
    recRef.current = rec;
  }, []);

  // Reuse one audio element so each reply can autoplay after the first user
  // gesture and the blob URL can be revoked safely after playback.
  useEffect(() => {
    const audio = new Audio();
    audio.onplay = () => setPhase("speaking");
    audio.onended = () => { setPhase("idle"); setTranscript(""); revokeUrl(); };
    audio.onerror = () => setPhase("idle");
    audioRef.current = audio;
    return () => {
      audio.pause();
      revokeUrl();
    };
  }, []);

  function revokeUrl() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }

  function stopAudio() {
    ttsAbortRef.current?.abort();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    revokeUrl();
    setPhase("idle");
  }

  const speak = useCallback(async (text) => {
    const clean = cleanForSpeech(text);
    if (!clean) return;

    stopAudio();
    const controller = new AbortController();
    ttsAbortRef.current = controller;

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error?.message || "Voice playback failed. Please try again.");
        setPhase("idle");
        return;
      }

      const buf = await res.arrayBuffer();
      if (controller.signal.aborted) return;

      revokeUrl();
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
      urlRef.current = url;

      const audio = audioRef.current;
      if (!audio) {
        setError("Audio playback is unavailable in this browser.");
        setPhase("idle");
        return;
      }

      audio.src = url;
      await audio.play();
    } catch {
      setPhase("idle");
    }
  }, []);

  const sendQuestion = useCallback(async (q) => {
    if (!q.trim()) return;
    setQuestion(q);
    setCaption("");
    setTranscript("");
    setPhase("thinking");
    setError("");
    try {
      // Calls our own dev-server proxy (see vite.config.js), which injects the
      // Anthropic API key server-side. The browser never sees the key.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: "user", content: q }],
        }),
      });
      const data = await res.json();
      const answer =
        data.content?.[0]?.text ||
        data.error?.message ||
        "I am sorry, please try again.";
      const spoken = cleanForSpeech(answer);
      setCaption(spoken);
      speak(spoken);
    } catch {
      setError("Connection failed. Please try again.");
      setPhase("idle");
    }
  }, [speak]);

  const toggleMic = () => {
    if (phase === "speaking") { stopAudio(); return; }
    if (phase === "listening") { recRef.current?.stop(); setPhase("idle"); return; }
    if (phase === "thinking") return;
    setError(""); setTranscript("");
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
                onClick={() => { setShowQuick(false); sendQuestion(q); }}
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

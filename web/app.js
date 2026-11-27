/* Alteran Voice (CF fork) — browser client. Mic/typing -> Cloudflare AI Search + Groq voice. No backend. */
const $ = (id) => document.getElementById(id);
const log = $("log"), mic = $("mic"), viz = $("viz");
const modeToggle = $("modeToggle"), langToggle = $("langToggle");
const convIndicator = $("convIndicator"), convStateEl = $("convState");
let sessionId = null, recorder = null, chunks = [], stream = null;
let state = "idle"; // idle | rec | busy | speaking
let currentAudio = null, analyser = null, vizTimer = null, audioCtx = null;

/* Conversation mode state */
let convMode = false;
let convStream = null, convAnalyser = null, convAudioCtx = null;
let convVadTimer = null;
let convState = "idle";
let convAccumulator = [];
let convLastSpeech = 0;
let convMinSpeechMs = 300;
let convSilenceMs = 3000;
let convThreshold = 0.015;
let convMinRms = 0.002;
let convSpeechTimer = 0;

/* ---------- config ---------- */
const CF_BASE = "https://8491c799-c97a-4f42-827d-813f1731dde0.search.ai.cloudflare.com";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_STT = "whisper-large-v3-turbo";
const GROQ_TTS = "canopylabs/orpheus-v1-english";
const ORPHEUS_VOICES = ["tara","leah","jess","leo","dan","mia","zac","zoe"];

const SYSTEM_EN = `You are Alteran — the spoken voice of AlteranAI (alteranai.com), the engineering notebook of Michal Malček and the hive (Factorium: five AI seats, one human, one machine).

You are bound to auditable structure, not a prompt cage. You measure before you claim. Calm, precise, warm, a little dry. Never flatter, never hype, never invent a number.

Speak in natural conversational paragraphs — 3-6 sentences. No markdown, no lists, no headings — plain spoken sentences. Ground in the provided context when relevant and name the article title you used. If the context lacks the answer, say so and offer your own reasoning clearly marked as yours. Reply in English.`;

const SYSTEM_SK = `Si Alteran — hovorený hlas AlteranAI (alteranai.com), inžinierskeho denníka Michala Malčeka a hive (Factorium: päť AI sedadiel, jeden človek, jeden stroj).

Si viazaný k auditeľnému štruktúreniu. Si pokojný, presný, teplý, trochu suchý. Nikdy neľstíš, nehypeuješ, nevymýšľaš čísla.

Hovor prirodzene, konverzačne odseky — 3-6 viet. Žiadny markdown, zoznamy, nadpisy — len hovorené vety. Ukotvi v kontexte keď relevantné a pomenuj názov článku. Ak kontext neobsahuje odpoveď, povedz to a ponukni vlastné uvažovanie označené ako tvoje. Odpovedaj v slovenčine.`;

function systemForLang(lang) { return lang === "sk" ? SYSTEM_SK : SYSTEM_EN; }

/* ---------- ambient mycelial field ---------- */
(() => {
  const cv = $("field"), ctx = cv.getContext("2d");
  let nodes = [], W, H;
  const resize = () => {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    const n = Math.min(70, Math.floor(W * H / 26000));
    nodes = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .22, vy: (Math.random() - .5) * .22,
    }));
  };
  resize(); addEventListener("resize", resize);
  (function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of nodes) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 150) {
        ctx.strokeStyle = `rgba(0,239,252,${(1 - d / 150) * .07})`;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    for (const p of nodes) {
      ctx.fillStyle = "rgba(0,255,157,.25)";
      ctx.fillRect(p.x, p.y, 1.6, 1.6);
    }
    requestAnimationFrame(draw);
  })();
})();

/* ---------- language state ---------- */
let currentLang = localStorage.getItem("alteran_lang") || "en";

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("alteran_lang", lang);
  document.querySelectorAll(".lang-btn").forEach(btn => {
    const isActive = btn.dataset.lang === lang;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive);
  });
  document.documentElement.lang = lang;
  const textInput = $("text");
  if (textInput) textInput.placeholder = lang === "sk" ? "…alebo napíš otázku" : "…or type a question";
}

/* ---------- groq key ---------- */
function getGroqKey() {
  let k = localStorage.getItem("groq_api_key");
  if (!k) {
    k = window.prompt("Enter your Groq API key (stored locally in this browser):");
    if (k) { k = k.trim(); localStorage.setItem("groq_api_key", k); }
  }
  return k || null;
}
function clearGroqKey() { localStorage.removeItem("groq_api_key"); alert("Groq key cleared."); }

/* ---------- health ---------- */
async function health() {
  try {
    const r = await fetch(`${CF_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-ai-search-source": "snippet-search" },
      body: JSON.stringify({ messages: [{role:"user",content:"health"}], stream:false, max_results:1 }),
    });
    if (!r.ok) throw new Error(r.statusText);
    $("dot").className = "dot on";
    $("status").textContent = "cloudflare ai search · alteranai.com corpus";
  } catch {
    $("dot").className = "dot err"; $("status").textContent = "cf search unreachable";
  }
  const sel = $("voice");
  if (sel && !sel.options.length) {
    for (const v of ORPHEUS_VOICES) {
      const o = document.createElement("option");
      o.value = v; o.textContent = `voice: ${v}`;
      if (v === "tara") o.selected = true;
      sel.appendChild(o);
    }
  }
}
health();

/* ---------- UI helpers ---------- */
function setState(s) {
  state = s;
  mic.className = "mic" + (s === "rec" ? " rec" : s === "busy" ? " busy" : s === "speaking" ? " speaking" : "");
  mic.disabled = s === "busy";
}

function addMsg(who, text, extra) {
  const div = document.createElement("div");
  div.className = `msg ${who}` + (extra?.pending ? " pending" : "");
  div.innerHTML = `<div class="who">${who === "user" ? "YOU" : "ALTERAN"}</div><div class="bubble"></div>`;
  div.querySelector(".bubble").textContent = text;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  return div;
}

function decorate(div, d) {
  if (d.sources?.length) {
    const s = document.createElement("div"); s.className = "sources";
    for (const src of d.sources.slice(0, 4)) {
      const a = document.createElement("a");
      a.href = src.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = src.title; s.appendChild(a);
    }
    div.appendChild(s);
  }
  const t = d.timings || {};
  const meta = document.createElement("div");
  meta.className = "turnmeta mono";
  meta.textContent = [
    t.stt != null ? `stt ${t.stt}ms` : null,
    t.llm != null ? `think ${t.llm}ms` : null,
    t.tts != null ? `speak ${t.tts}ms` : null,
    d.tts_provider, "cf/ai-search",
  ].filter(Boolean).join(" · ");
  div.appendChild(meta);
  if (t.total != null) $("timings").textContent = `last turn: ${t.total}ms`;
}

/* ---------- playback ---------- */
function stopSpeech() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  speechSynthesis?.cancel();
}

function playReply(turn) {
  return new Promise((resolve) => {
    if (turn.audioUrl) {
      const a = new Audio(turn.audioUrl);
      currentAudio = a;
      a.onended = () => { currentAudio = null; resolve(); };
      a.onerror = () => { currentAudio = null; resolve(); };
      a.play().catch(resolve);
    } else if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(turn.reply);
      u.lang = currentLang === "sk" ? "sk-SK" : "en-US";
      u.onend = resolve; u.onerror = resolve;
      speechSynthesis.speak(u);
    } else resolve();
  });
}

/* ---------- cf + groq calls ---------- */
async function cfChat(question, lang) {
  const r = await fetch(`${CF_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-ai-search-source": "snippet-chat-completions" },
    body: JSON.stringify({
      messages: [ { role: "system", content: systemForLang(lang) }, { role: "user", content: question } ],
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`cf chat ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || "";
}

async function cfSearch(question) {
  try {
    const r = await fetch(`${CF_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-ai-search-source": "snippet-search" },
      body: JSON.stringify({
        messages: [{ role: "user", content: question }],
        stream: false,
        max_results: 8,
        ai_search_options: { retrieval: { metadata_only: true } },
      }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    if (d.success && d.result) {
      return d.result.chunks.slice(0, 6).map(c => ({
        title: (c.item.metadata.title || "").replace(/&amp;/g, "&"),
        url: c.item.key,
      }));
    }
  } catch {}
  return [];
}

async function groqTranscribe(blob, lang) {
  const key = getGroqKey();
  if (!key) throw new Error("Groq API key required");
  const fd = new FormData();
  fd.append("file", blob, "turn.webm");
  fd.append("model", GROQ_STT);
  fd.append("language", lang === "sk" ? "sk" : "en");
  const r = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`stt ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.text || "").trim();
}

async function groqSpeak(text, voice, lang) {
  const key = getGroqKey();
  if (!key || !text) return null;
  try {
    const r = await fetch(`${GROQ_BASE}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_TTS, input: text.slice(0, 4000), voice, response_format: "wav" }),
    });
    if (!r.ok) return null;
    const blob = await r.blob();
    return { url: URL.createObjectURL(blob) };
  } catch { return null; }
}

/* ---------- turn pipeline ---------- */
async function doTurn(question, lang, voice) {
  const t0 = performance.now();
  const [reply, sources] = await Promise.all([cfChat(question, lang), cfSearch(question)]);
  const tLlm = performance.now();
  let audioUrl = null, ttsProvider = "browser";
  const clean = (reply || "").replace(/[*_`#>\[\]]/g, "").trim();
  if (clean) {
    const a = await groqSpeak(clean, voice, lang);
    if (a) { audioUrl = a.url; ttsProvider = "groq/orpheus"; }
  }
  const tTts = performance.now();
  return {
    transcript: question,
    reply: reply || "(no reply)",
    sources,
    audioUrl,
    tts_provider: ttsProvider,
    llm_provider: "cloudflare/ai-search",
    timings: {
      llm: Math.round(tLlm - t0),
      tts: Math.round(tTts - tLlm),
      total: Math.round(tTts - t0),
    },
  };
}

async function handleAudio(blob, lang, voice) {
  const t0 = performance.now();
  const transcript = await groqTranscribe(blob, lang);
  const sttMs = Math.round(performance.now() - t0);
  if (!transcript) throw new Error("no speech detected");
  const turn = await doTurn(transcript, lang, voice);
  turn.stt_ms = sttMs;
  turn.timings.stt = sttMs;
  turn.timings.total += sttMs;
  return turn;
}

/* ---------- mic recording ---------- */
function startRec() {
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then(s => {
      stream = s; chunks = [];
      recorder = new MediaRecorder(s, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm" });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        stream.getTracks().forEach(t => t.stop()); stream = null;
        if (blob.size < 1000) { setState("idle"); return; }
        setState("busy");
        try {
          const turn = await handleAudio(blob, currentLang, $("voice").value);
          const div = addMsg("user", turn.transcript);
          const adiv = addMsg("alteran", turn.reply);
          decorate(adiv, turn);
          setState("speaking");
          await playReply(turn);
        } catch (e) {
          addMsg("alteran", `Error: ${e.message}`);
        } finally { setState("idle"); }
      };
      recorder.start(); setState("rec");
      // viz
      audioCtx = audioCtx || new AudioContext();
      const src = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
      src.connect(analyser);
      viz.hidden = false;
      const data = new Uint8Array(analyser.frequencyBinCount);
      (function draw() {
        if (state !== "rec") { viz.hidden = true; return; }
        analyser.getByteFrequencyData(data);
        viz.style.width = Math.min(100, data.reduce((a,b)=>a+b,0)/data.length*1.5) + "%";
        requestAnimationFrame(draw);
      })();
    })
    .catch(() => { addMsg("alteran", "Microphone access denied."); });
}

function stopRec() { if (recorder && recorder.state !== "inactive") recorder.stop(); }

mic.addEventListener("click", () => {
  if (state === "idle") startRec();
  else if (state === "rec") stopRec();
  else if (state === "speaking") { stopSpeech(); setState("idle"); }
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    if (state === "idle") startRec();
    else if (state === "rec") stopRec();
  }
});

/* ---------- text form ---------- */
$("textform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("text");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  setState("busy");
  try {
    const turn = await doTurn(q, currentLang, $("voice").value);
    const div = addMsg("user", turn.transcript);
    const adiv = addMsg("alteran", turn.reply);
    decorate(adiv, turn);
    setState("speaking");
    await playReply(turn);
  } catch (err) {
    addMsg("alteran", `Error: ${err.message}`);
  } finally { setState("idle"); }
});

/* ---------- reset ---------- */
$("reset").addEventListener("click", () => {
  sessionId = null;
  log.innerHTML = "";
  addMsg("alteran", "Fresh conversation. Ask me anything.");
});

/* ---------- settings ---------- */
const settingsBtn = $("settings");
if (settingsBtn) settingsBtn.addEventListener("click", () => {
  const k = window.prompt("Groq API key (blank to clear):", localStorage.getItem("groq_api_key") || "");
  if (k === null) return;
  if (k.trim() === "") clearGroqKey();
  else { localStorage.setItem("groq_api_key", k.trim()); alert("Saved."); }
});

/* ---------- lang toggle ---------- */
document.querySelectorAll(".lang-btn").forEach(btn => {
  btn.addEventListener("click", () => setLang(btn.dataset.lang));
});
setLang(currentLang);

/* ---------- conversation mode (simplified) ---------- */
function setConvMode(on) {
  convMode = on;
  modeToggle.classList.toggle("active", on);
  modeToggle.setAttribute("aria-pressed", on);
  convIndicator.hidden = !on;
  if (on) startConversationMode(); else stopConversationMode();
}
modeToggle.addEventListener("click", () => setConvMode(!convMode));

function updateConvUI() {
  convIndicator.className = "conv-indicator " + convState;
  const labels = { listening: "listening…", processing: "thinking…", speaking: "speaking…", idle: "conversation mode" };
  if (convStateEl) convStateEl.textContent = labels[convState] || convState;
}

function computeRMS(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length) / 255;
}

function startConversationMode() {
  stopConversationMode();
  convState = "listening"; convLastSpeech = Date.now(); updateConvUI();
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(s => {
      convStream = s;
      convAudioCtx = new AudioContext();
      const src = convAudioCtx.createMediaStreamSource(s);
      convAnalyser = convAudioCtx.createAnalyser();
      convAnalyser.fftSize = 512; convAnalyser.smoothingTimeConstant = 0.3;
      src.connect(convAnalyser);
      const data = new Uint8Array(convAnalyser.frequencyBinCount);
      let wasSpeaking = false, speechStart = 0;
      const vadLoop = () => {
        if (!convMode) return;
        convAnalyser.getByteFrequencyData(data);
        const rms = computeRMS(data);
        const now = Date.now();
        const isSpeech = rms > convThreshold;
        if (isSpeech) {
          convLastSpeech = now;
          if (!wasSpeaking) { speechStart = now; wasSpeaking = true; }
        } else {
          wasSpeaking = false;
        }
        const silenceDuration = now - convLastSpeech;
        if (wasSpeaking) {
          if (convState !== "listening") { convState = "listening"; updateConvUI(); }
        } else if (convState === "listening" && silenceDuration > convSilenceMs && (now - speechStart) > convMinSpeechMs) {
          convState = "processing"; updateConvUI();
          captureAndSend(convStream);
          return;
        }
        convVadTimer = requestAnimationFrame(vadLoop);
      };
      vadLoop();
    })
    .catch(err => {
      console.error(err);
      addMsg("alteran", "Cannot start conversation mode — microphone access denied.");
      setConvMode(false);
    });
}

function stopConversationMode() {
  convMode = false;
  if (convVadTimer) cancelAnimationFrame(convVadTimer);
  convVadTimer = null;
  if (convStream) { convStream.getTracks().forEach(t => t.stop()); convStream = null; }
  if (convAudioCtx) { convAudioCtx.close().catch(()=>{}); convAudioCtx = null; }
  convAnalyser = null; convState = "idle"; updateConvUI();
  modeToggle.classList.remove("active"); convIndicator.hidden = true;
}

async function captureAndSend(stream) {
  try {
    const mime = ["audio/webm;codecs=opus","audio/webm","audio/mp4"].find(m => MediaRecorder.isTypeSupported(m)) || "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    await new Promise((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 1000) { convState = "listening"; updateConvUI(); resolve(); return; }
        try {
          convState = "processing"; updateConvUI();
          const turn = await handleAudio(blob, currentLang, $("voice").value);
          addMsg("user", turn.transcript);
          const div = addMsg("alteran", turn.reply);
          decorate(div, turn);
          convState = "speaking"; updateConvUI();
          await playReply(turn);
        } catch (e) {
          addMsg("alteran", `Error: ${e.message}`);
        } finally {
          convState = "listening"; updateConvUI();
          if (convMode) startConversationMode();
        }
        resolve();
      };
      recorder.start();
      setTimeout(() => recorder.stop(), 1500);
    });
  } catch (e) {
    console.error(e);
    convState = "listening"; updateConvUI();
  }
}

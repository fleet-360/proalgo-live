/* global live */
"use strict";

const $ = (id) => document.getElementById(id);
const views = ["idle", "live", "ended", "settings"];
let currentView = "idle";

function show(view) {
  for (const v of views) $(`view-${v}`).classList.toggle("hidden", v !== view);
  if (view !== "settings") currentView = view;
}

function setStatus(text, rec = false) {
  $("status").textContent = text;
  $("status").classList.toggle("rec", rec);
}

function showError(id, err) {
  const el = $(id);
  if (!err) return el.classList.add("hidden");
  el.textContent = typeof err === "string" ? err : err.message || String(err);
  el.classList.remove("hidden");
}

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// ------------------------------------------------------------------
// Recording one audio channel in standalone ~15s webm chunks.
// Silent chunks are dropped so speech-to-text doesn't invent words.
// ------------------------------------------------------------------

const MIME = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
const VOICE_RMS = 0.012; // level that counts as speech
let minVoicedTicks = 5; // at least ~0.5s of speech per chunk
let uploadFn = (payload) => live.uploadAudio(payload);

class ChannelRecorder {
  constructor({ track, speaker, audioCtx, meterEl, chunkMs, sessionStart, onChunk }) {
    this.stream = new MediaStream([track]);
    this.speaker = speaker;
    this.meterEl = meterEl;
    this.chunkMs = chunkMs;
    this.sessionStart = sessionStart;
    this.onChunk = onChunk;
    this.current = null;
    const src = audioCtx.createMediaStreamSource(this.stream);
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  start() {
    this.current = this._newRecorder();
    this.cycleTimer = setInterval(() => {
      const old = this.current;
      this.current = this._newRecorder(); // start the next one first so no words fall in a gap
      old.rec.stop();
    }, this.chunkMs);
    this.levelTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      if (rms > VOICE_RMS && this.current) this.current.voiced++;
      this.meterEl.style.width = `${Math.min(100, rms * 600)}%`;
    }, 100);
  }

  _newRecorder() {
    const rec = new MediaRecorder(this.stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
    const state = { rec, parts: [], voiced: 0, t: Date.now() - this.sessionStart };
    rec.ondataavailable = (e) => e.data && e.data.size && state.parts.push(e.data);
    rec.onstop = () => {
      if (state.voiced >= minVoicedTicks && state.parts.length) {
        this.onChunk(new Blob(state.parts, { type: MIME }), state.t, this.speaker);
      }
    };
    rec.start();
    return state;
  }

  /** Stops recording and emits the last partial chunk. */
  stop() {
    clearInterval(this.cycleTimer);
    clearInterval(this.levelTimer);
    this.meterEl.style.width = "0%";
    if (this.current && this.current.rec.state !== "inactive") this.current.rec.stop();
    this.current = null;
  }
}

// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------

let cfg = null;
let sess = null; // { id, publicUrl, start, recorders, streams, audioCtx, pending:Set, ... }

async function startSession() {
  showError("idle-error", null);
  $("btn-start").disabled = true;
  setStatus("מתחבר לשרת…");
  try {
    cfg = await live.getConfig();
    if (!cfg.serverUrl) throw new Error("צריך להגדיר כתובת שרת (⚙ הגדרות).");

    // Microphone = the salesperson.
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // Computer sound = the client (Zoom / Meet / Teams output).
    let loop = null;
    try {
      loop = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 } });
      loop.getVideoTracks().forEach((t) => (t.enabled = false));
      if (!loop.getAudioTracks().length) loop = null;
    } catch (e) {
      console.warn("loopback capture failed", e);
      loop = null;
    }

    const created = await live.api("POST", "/api/sessions", { clientName: $("client-name").value.trim() });
    const start = Date.now();
    const audioCtx = new AudioContext();
    sess = {
      id: created.id,
      publicUrl: created.publicUrl,
      start,
      audioCtx,
      streams: [mic, loop].filter(Boolean),
      pending: new Set(),
      recorders: [],
      lastAnalyze: Date.now(),
      analyzing: false,
      ended: false,
    };

    const chunkMs = Math.max(8, Number(cfg.chunkSeconds) || 15) * 1000;
    const common = { audioCtx, chunkMs, sessionStart: start, onChunk: uploadChunk };
    sess.recorders.push(new ChannelRecorder({ ...common, track: mic.getAudioTracks()[0], speaker: "sales", meterEl: $("lvl-sales") }));
    if (loop) {
      sess.recorders.push(new ChannelRecorder({ ...common, track: loop.getAudioTracks()[0], speaker: "client", meterEl: $("lvl-client") }));
    }
    sess.recorders.forEach((r) => r.start());
    $("loopback-warn").classList.toggle("hidden", !!loop);

    await live.setRecording(true);
    await live.copy(sess.publicUrl);
    $("public-url").textContent = sess.publicUrl;
    $("transcript").innerHTML = "";
    resetInsights();
    show("live");
    setStatus("מקשיב לשיחה", true);
    sess.ticker = setInterval(tick, 1000);
  } catch (e) {
    console.error(e);
    const msg =
      e && e.name === "NotAllowedError"
        ? "אין הרשאה למיקרופון. צריך לאשר גישה למיקרופון בהגדרות הפרטיות של Windows."
        : e.message || String(e);
    showError("idle-error", msg);
    setStatus("מוכן");
    cleanupStreams();
  } finally {
    $("btn-start").disabled = false;
  }
}

function uploadChunk(blob, t, speaker) {
  if (!sess) return;
  const id = sess.id;
  const p = (async () => {
    const buffer = await blob.arrayBuffer();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await uploadFn({ sessionId: id, speaker, t, buffer, mime: blob.type });
        if (res.text) addSegment(speaker, res.text);
        showError("live-error", null);
        return;
      } catch (e) {
        if (attempt === 1) showError("live-error", `תמלול נכשל: ${e.message || e}`);
        else await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  sess.pending.add(p);
  p.finally(() => sess && sess.pending.delete(p));
}

function addSegment(speaker, text) {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const div = document.createElement("div");
  div.className = `seg ${speaker}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = speaker === "client" ? "לקוח:" : "אני:";
  div.append(who, document.createTextNode(text));
  box.append(div);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function tick() {
  if (!sess || sess.ended) return;
  $("timer").textContent = fmt(Date.now() - sess.start);
  const every = Math.max(30, Number(cfg.analyzeEverySeconds) || 120) * 1000;
  const left = every - (Date.now() - sess.lastAnalyze);
  if (sess.analyzing) $("next-update").textContent = "ה-AI מעדכן את התוכנית…";
  else $("next-update").textContent = `עדכון הבא בעוד ${fmt(left)}`;
  if (left <= 0 && !sess.analyzing) runAnalyze(false);
}

async function runAnalyze(force) {
  if (!sess || sess.analyzing) return;
  sess.analyzing = true;
  sess.lastAnalyze = Date.now();
  $("btn-update").disabled = true;
  try {
    const res = await live.api("POST", `/api/sessions/${sess.id}/analyze`, { force: !!force });
    if (res.insights) renderInsights(res.insights);
    if (res.error) showError("live-error", res.error);
  } catch (e) {
    showError("live-error", `עדכון התוכנית נכשל: ${e.message || e}`);
  } finally {
    if (sess) {
      sess.analyzing = false;
      sess.lastAnalyze = Date.now();
    }
    $("btn-update").disabled = false;
  }
}

async function sendNote() {
  const text = $("note").value.trim();
  if (!text || !sess) return;
  $("btn-note").disabled = true;
  try {
    await live.api("POST", `/api/sessions/${sess.id}/note`, { text });
    $("note").value = "";
    runAnalyze(true);
  } catch (e) {
    showError("live-error", e.message || String(e));
  } finally {
    $("btn-note").disabled = false;
  }
}

async function endSession() {
  if (!sess || sess.ended) return;
  sess.ended = true;
  clearInterval(sess.ticker);
  $("btn-end").disabled = true;
  sess.recorders.forEach((r) => r.stop());
  setStatus("מסיים…");
  $("ended-url").textContent = sess.publicUrl;
  $("ended-msg").textContent = "מתמלל את הדקות האחרונות ומכין את הגרסה הסופית…";
  show("ended");
  await new Promise((r) => setTimeout(r, 400)); // let the last chunks fire onstop
  await Promise.allSettled([...sess.pending]);
  cleanupStreams();
  await live.setRecording(false);
  // Wait for an analysis already running, then run the final one.
  for (let i = 0; i < 60 && sess.analyzing; i++) await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await live.api("POST", `/api/sessions/${sess.id}/analyze`, { final: true });
    if (res.error) {
      $("ended-msg").textContent = `הגרסה הסופית לא נוצרה: ${res.error}. הקישור מציג את הגרסה האחרונה.`;
    } else if (!res.version) {
      $("ended-msg").textContent = "לא נקלט מספיק דיבור כדי לבנות תוכנית. כדאי לבדוק את המיקרופון ואת הגדרות התמלול.";
    } else {
      $("ended-msg").textContent = "הגרסה הסופית מוכנה. זה הקישור לתוכנית, גם בשביל המתכנת.";
    }
  } catch (e) {
    $("ended-msg").textContent = `הגרסה הסופית לא נוצרה: ${e.message || e}. הקישור מציג את הגרסה האחרונה.`;
  }
  setStatus("מוכן");
  $("btn-end").disabled = false;
}

function cleanupStreams() {
  if (!sess) return;
  for (const s of sess.streams) s.getTracks().forEach((t) => t.stop());
  sess.streams = [];
  if (sess.audioCtx && sess.audioCtx.state !== "closed") sess.audioCtx.close();
}

// ------------------------------------------------------------------
// Private insights panel
// ------------------------------------------------------------------

function fillList(id, items) {
  const ul = $(id);
  ul.innerHTML = "";
  for (const text of items || []) {
    const li = document.createElement("li");
    li.textContent = text;
    ul.append(li);
  }
  if (!ul.children.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "—";
    ul.append(li);
  }
}

function renderInsights(ins) {
  fillList("ins-questions", ins.questions);
  fillList("ins-roi", ins.roi);
  fillList("ins-risks", ins.risks);
  const label = { low: "ביטחון נמוך", medium: "ביטחון בינוני", high: "ביטחון גבוה" }[ins.confidence] || "";
  $("confidence").textContent = label ? `· ${label}` : "";
}

function resetInsights() {
  $("ins-questions").innerHTML = '<li class="muted">יופיע אחרי העדכון הראשון</li>';
  $("ins-roi").innerHTML = "";
  $("ins-risks").innerHTML = "";
  $("confidence").textContent = "";
}

// ------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------

async function openSettings() {
  cfg = await live.getConfig();
  $("cfg-server").value = cfg.serverUrl || "";
  $("cfg-token").value = cfg.appToken || "";
  $("cfg-every").value = cfg.analyzeEverySeconds || 120;
  $("cfg-mic").checked = !!cfg.micAlerts;
  $("cfg-login").checked = !!cfg.openAtLogin;
  $("version").textContent = `גרסה ${await live.version()}`;
  show("settings");
}

async function saveSettings() {
  cfg = await live.setConfig({
    serverUrl: $("cfg-server").value.trim().replace(/\/+$/, ""),
    appToken: $("cfg-token").value.trim(),
    analyzeEverySeconds: Math.min(900, Math.max(30, Number($("cfg-every").value) || 120)),
    micAlerts: $("cfg-mic").checked,
    openAtLogin: $("cfg-login").checked,
  });
  show(currentView);
}

// ------------------------------------------------------------------
// Wiring
// ------------------------------------------------------------------

$("btn-start").addEventListener("click", startSession);
$("client-name").addEventListener("keydown", (e) => e.key === "Enter" && startSession());
$("btn-update").addEventListener("click", () => runAnalyze(true));
$("btn-note").addEventListener("click", sendNote);
$("note").addEventListener("keydown", (e) => e.key === "Enter" && sendNote());
$("btn-end").addEventListener("click", endSession);
$("btn-copy").addEventListener("click", () => sess && live.copy(sess.publicUrl));
$("btn-open").addEventListener("click", () => sess && live.openExternal(sess.publicUrl));
$("btn-copy2").addEventListener("click", () => sess && live.copy(sess.publicUrl));
$("btn-open2").addEventListener("click", () => sess && live.openExternal(sess.publicUrl));
$("btn-new").addEventListener("click", () => {
  sess = null;
  $("client-name").value = "";
  show("idle");
});
$("btn-settings").addEventListener("click", openSettings);
$("btn-save").addEventListener("click", saveSettings);
$("btn-cancel").addEventListener("click", () => show(currentView));

live.onPromptStart(() => {
  if (currentView === "idle") {
    $("mic-banner").classList.remove("hidden");
    $("client-name").focus();
  }
});
live.onMicActive(({ active }) => {
  if (currentView === "idle") $("mic-banner").classList.toggle("hidden", !active);
});

(async () => {
  cfg = await live.getConfig();
  if (new URLSearchParams(location.search).has("selftest")) return runSelfTest();
  if (!cfg.serverUrl) openSettings();
})();

/** Records ~20s (uploading every chunk, even silence), ends the session, reports and quits. */
async function runSelfTest() {
  const report = { chunks: { sales: 0, client: 0 }, uploads: 0, uploadErrors: [] };
  minVoicedTicks = 0; // upload even silent chunks
  uploadFn = async (payload) => {
    report.chunks[payload.speaker]++;
    try {
      const r = await live.uploadAudio(payload);
      report.uploads++;
      return r;
    } catch (e) {
      report.uploadErrors.push(String(e.message || e).slice(0, 160));
      throw e;
    }
  };
  $("client-name").value = "בדיקה עצמית";
  await startSession();
  report.sessionId = sess && sess.id;
  report.loopback = !!(sess && sess.recorders.length === 2);
  report.startError = $("idle-error").classList.contains("hidden") ? null : $("idle-error").textContent;
  if (!sess) return live.selfTestDone(report);
  await new Promise((r) => setTimeout(r, 20000));
  await endSession();
  report.endedMessage = $("ended-msg").textContent;
  live.selfTestDone(report);
}

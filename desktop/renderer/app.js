/* global live */
"use strict";

const $ = (id) => document.getElementById(id);
const views = ["idle", "live", "ended", "settings"];
let currentView = "idle";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function show(view) {
  for (const v of views) $(`view-${v}`).classList.toggle("hidden", v !== view);
  if (view !== "settings") currentView = view;
}

function setStatus(text, rec = false) {
  $("status").textContent = text;
  $("status").classList.toggle("rec", rec);
}

/** Error text for the Hebrew UI, without Electron's "Error invoking remote method" wrapper. */
function errText(err) {
  const raw = typeof err === "string" ? err : (err && err.message) || String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/, "");
}

function showError(id, err) {
  const el = $(id);
  if (!err) return el.classList.add("hidden");
  el.textContent = errText(err);
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
// Recording one audio channel in standalone webm chunks.
// Silent chunks are dropped so speech-to-text doesn't invent words.
// ------------------------------------------------------------------

const MIME = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
const VOICE_RMS = 0.012; // level that counts as speech
let minVoicedTicks = 5; // at least ~0.5s of speech per chunk
let uploadFn = (payload) => live.uploadAudio(payload);

class ChannelRecorder {
  constructor({ track, speaker, audioCtx, meterEl, chunkMs, sessionStart, onChunk, onDead }) {
    this.track = track;
    this.stream = new MediaStream([track]);
    this.speaker = speaker;
    this.meterEl = meterEl;
    this.chunkMs = chunkMs;
    this.sessionStart = sessionStart;
    this.onChunk = onChunk;
    this.onDead = onDead;
    this.current = null;
    this.dead = false;
    this.lastVoice = Date.now();
    const src = audioCtx.createMediaStreamSource(this.stream);
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    // Headset unplugged, Bluetooth dropped, sleep/resume: the track ends and this channel must be replaced.
    track.addEventListener("ended", () => this._die());
  }

  start() {
    this.current = this._newRecorder();
    this.cycleTimer = setInterval(() => {
      try {
        const old = this.current;
        this.current = this._newRecorder(); // start the next one first so no words fall in a gap
        if (old && old.rec.state !== "inactive") old.rec.stop();
      } catch (e) {
        console.warn(`${this.speaker} recorder failed`, e);
        this._die();
      }
    }, this.chunkMs);
    this.levelTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      if (rms > VOICE_RMS) {
        this.lastVoice = Date.now();
        if (this.current) this.current.voiced++;
      }
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

  _die() {
    if (this.dead) return;
    this.stop();
    this.dead = true;
    if (this.onDead) this.onDead(this);
  }

  /** Stops recording and emits the last partial chunk. */
  stop() {
    clearInterval(this.cycleTimer);
    clearInterval(this.levelTimer);
    this.meterEl.style.width = "0%";
    try {
      if (this.current && this.current.rec.state !== "inactive") this.current.rec.stop();
    } catch {
      // the stream is already gone
    }
    this.current = null;
  }
}

// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------

let cfg = null;
let sess = null; // the current call (see startSession)
let starting = false;

async function captureMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/** Computer sound = the client (Zoom / Meet / Teams output). Returns null if it can't be captured. */
async function captureLoopback() {
  try {
    const loop = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 } });
    loop.getVideoTracks().forEach((t) => (t.enabled = false));
    if (!loop.getAudioTracks().length) {
      loop.getTracks().forEach((t) => t.stop());
      return null;
    }
    return loop;
  } catch (e) {
    console.warn("loopback capture failed", e);
    return null;
  }
}

function addRecorder(s, stream, speaker) {
  const rec = new ChannelRecorder({
    track: stream.getAudioTracks()[0],
    speaker,
    audioCtx: s.audioCtx,
    meterEl: $(speaker === "client" ? "lvl-client" : "lvl-sales"),
    chunkMs: s.chunkMs,
    sessionStart: s.start,
    onChunk: (blob, t, who) => uploadChunk(s, blob, t, who),
    onDead: (r) => onChannelDead(s, r),
  });
  s.streams.push(stream);
  s.recorders.push(rec);
  rec.start();
  return rec;
}

async function startSession() {
  if (starting || (sess && !sess.ended)) return;
  starting = true;
  showError("idle-error", null);
  $("btn-start").disabled = true;
  setStatus("מתחבר לשרת…");
  let mic = null;
  let loop = null;
  try {
    cfg = await live.getConfig();
    if (!cfg.serverUrl) throw new Error("צריך להגדיר כתובת שרת (⚙ הגדרות).");

    mic = await captureMic(); // the salesperson
    loop = await captureLoopback(); // the client
    const created = await live.api("POST", "/api/sessions", { clientName: $("client-name").value.trim() });

    const start = Date.now();
    const s = {
      id: created.id,
      publicUrl: created.publicUrl,
      start,
      audioCtx: new AudioContext(),
      chunkMs: Math.max(8, Number(cfg.chunkSeconds) || 20) * 1000,
      streams: [],
      recorders: [],
      inflight: new Set(), // upload promises still running
      waiting: 0, // chunks waiting to be resent
      lastAnalyze: Date.now(),
      analyzing: false,
      rerunAfter: false,
      ended: false,
      finalizing: false,
    };
    sess = s;
    addRecorder(s, mic, "sales");
    if (loop) addRecorder(s, loop, "client");
    mic = loop = null; // owned by the session now

    // Fresh screen for this call.
    showError("live-error", null);
    $("loopback-warn").classList.toggle("hidden", s.recorders.length === 2);
    $("device-warn").classList.add("hidden");
    $("call-ended-banner").classList.add("hidden");
    $("note-status").classList.add("hidden");
    $("timer").textContent = "00:00";
    $("next-update").textContent = "";
    updateQueueInfo(s);
    $("public-url").textContent = s.publicUrl;
    $("transcript").innerHTML = "";
    resetInsights();

    await live.setRecording(true);
    await live.copy(s.publicUrl);
    show("live");
    setStatus("מקשיב לשיחה", true);
    s.ticker = setInterval(tick, 1000);
  } catch (e) {
    console.error(e);
    [mic, loop].forEach((st) => st && st.getTracks().forEach((t) => t.stop()));
    const msg =
      e && e.name === "NotAllowedError"
        ? "אין הרשאה למיקרופון. צריך לאשר גישה למיקרופון בהגדרות הפרטיות של Windows."
        : errText(e);
    showError("idle-error", msg);
    setStatus("מוכן");
  } finally {
    starting = false;
    $("btn-start").disabled = false;
  }
}

/** A channel's device went away: show it, and keep trying to get it back while the call is on. */
async function onChannelDead(s, rec) {
  if (s.ended) return;
  s.recorders = s.recorders.filter((r) => r !== rec);
  const who = rec.speaker === "client" ? "סאונד המחשב (הלקוח)" : "המיקרופון";
  const warn = $("device-warn");
  warn.innerHTML = `<div><b>${who} התנתק.</b> מנסה להתחבר מחדש…</div>`;
  warn.classList.remove("hidden");
  for (let attempt = 0; !s.ended; attempt++) {
    await sleep(attempt === 0 ? 1500 : 5000);
    if (s.ended) return;
    try {
      const stream = rec.speaker === "client" ? await captureLoopback() : await captureMic();
      if (!stream) continue;
      if (s.ended) return stream.getTracks().forEach((t) => t.stop());
      addRecorder(s, stream, rec.speaker);
      warn.classList.add("hidden");
      if (rec.speaker === "client") $("loopback-warn").classList.add("hidden");
      return;
    } catch (e) {
      console.warn("reconnect failed", e);
    }
  }
}

async function retryLoopback() {
  const s = sess;
  if (!s || s.ended) return;
  $("btn-loopback-retry").disabled = true;
  try {
    const loop = await captureLoopback();
    if (loop && !s.ended && !s.recorders.some((r) => r.speaker === "client")) {
      addRecorder(s, loop, "client");
      $("loopback-warn").classList.add("hidden");
    } else if (loop) {
      loop.getTracks().forEach((t) => t.stop());
    }
  } finally {
    $("btn-loopback-retry").disabled = false;
  }
}

// ----- uploads: retried with backoff so a Wi-Fi blip doesn't lose the client's words -----

const RETRY_DELAYS = [2000, 5000, 10000, 15000, 15000, 15000, 15000, 15000];

function updateQueueInfo(s) {
  const el = $("queue-info");
  if (s !== sess) return;
  el.textContent = s.waiting ? `${s.waiting} קטעים ממתינים לשליחה (אין חיבור יציב)` : "";
  el.classList.toggle("hidden", !s.waiting);
}

function uploadChunk(s, blob, t, speaker) {
  const p = (async () => {
    const buffer = await blob.arrayBuffer();
    let waitingCounted = false;
    try {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await uploadFn({ sessionId: s.id, speaker, t, buffer, mime: blob.type });
        } catch (e) {
          res = { ok: false, status: 0, error: errText(e) };
        }
        if (res.ok !== false) {
          if (res.text && s === sess) addSegment(speaker, res.text);
          if (s === sess) showError("live-error", null);
          return;
        }
        const retryable = !res.status || res.status >= 500 || res.status === 408 || res.status === 429;
        if (!retryable || attempt >= RETRY_DELAYS.length) {
          if (s === sess) showError("live-error", `קטע מהשיחה לא תומלל: ${res.error}`);
          return;
        }
        if (!waitingCounted) {
          waitingCounted = true;
          s.waiting++;
          updateQueueInfo(s);
        }
        await sleep(RETRY_DELAYS[attempt]);
      }
    } finally {
      if (waitingCounted) {
        s.waiting--;
        updateQueueInfo(s);
      }
    }
  })();
  s.inflight.add(p);
  p.finally(() => s.inflight.delete(p));
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
  const s = sess;
  if (!s || s.ended) return;
  $("timer").textContent = fmt(Date.now() - s.start);
  const every = Math.max(30, Number(cfg.analyzeEverySeconds) || 120) * 1000;
  const left = every - (Date.now() - s.lastAnalyze);
  if (s.analyzing) $("next-update").textContent = "ה-AI מעדכן את התוכנית…";
  else $("next-update").textContent = `עדכון הבא בעוד ${fmt(left)}`;
  if (left <= 0 && !s.analyzing) runAnalyze(false);
}

async function runAnalyze(force) {
  const s = sess;
  if (!s || s.ended) return;
  if (s.analyzing) {
    // A note or "update now" while an update runs: do one more pass right after it.
    if (force) s.rerunAfter = true;
    return;
  }
  s.analyzing = true;
  s.lastAnalyze = Date.now();
  $("btn-update").disabled = true;
  let busy = false;
  try {
    const res = await live.api("POST", `/api/sessions/${s.id}/analyze`, { force: !!force });
    if (s !== sess) return;
    if (res.insights) renderInsights(res.insights);
    busy = res.status === 409;
    if (res.error) showError("live-error", `עדכון התוכנית נכשל: ${res.error}`);
    else if (!busy) showError("live-error", null);
  } catch (e) {
    if (s === sess) showError("live-error", `עדכון התוכנית נכשל: ${errText(e)}`);
  } finally {
    s.analyzing = false;
    s.lastAnalyze = Date.now();
    if (s === sess) $("btn-update").disabled = false;
    if (s === sess && !s.ended) {
      $("note-status").classList.add("hidden");
      if (s.rerunAfter || (busy && force)) {
        s.rerunAfter = false;
        setTimeout(() => runAnalyze(true), busy ? 10000 : 0);
      }
    }
  }
}

async function sendNote() {
  const s = sess;
  const text = $("note").value.trim();
  if (!text || !s || s.ended) return;
  $("btn-note").disabled = true;
  try {
    await live.api("POST", `/api/sessions/${s.id}/note`, { text });
    $("note").value = "";
    const ns = $("note-status");
    ns.textContent = s.analyzing ? "ההערה תיכנס בעדכון שמיד אחרי העדכון הנוכחי" : "ההערה נשלחה, מעדכן את התוכנית…";
    ns.classList.remove("hidden");
    runAnalyze(true);
  } catch (e) {
    showError("live-error", errText(e));
  } finally {
    $("btn-note").disabled = false;
  }
}

async function endSession() {
  const s = sess;
  if (!s || s.ended) return;
  s.ended = true;
  s.finalizing = true;
  clearInterval(s.ticker);
  $("btn-end").disabled = true;
  s.recorders.forEach((r) => r.stop());
  setStatus("מסיים…");
  $("ended-url").textContent = s.publicUrl;
  $("ended-msg").textContent = "מתמלל את הדקות האחרונות ומכין את הגרסה הסופית…";
  $("btn-retry-final").classList.add("hidden");
  $("btn-new").disabled = true;
  $("btn-new").textContent = "מכין גרסה סופית…";
  show("ended");

  await sleep(400); // let the last chunks fire onstop
  // Give queued uploads up to 90s to get through.
  await Promise.race([Promise.allSettled([...s.inflight]), sleep(90000)]);
  cleanupStreams(s);
  await live.setRecording(false);

  // An update may still be running; the final pass needs the lock, so wait for it (up to 5 minutes).
  for (let i = 0; i < 300 && s.analyzing; i++) await sleep(1000);
  await finalizeSession(s);

  s.finalizing = false;
  setStatus("מוכן");
  $("btn-end").disabled = false;
  $("btn-new").disabled = false;
  $("btn-new").textContent = "שיחה חדשה";
}

/** Asks the server for the final version, waiting while another update holds the lock. */
async function finalizeSession(s) {
  const msg = $("ended-msg");
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    let res;
    try {
      res = await live.api("POST", `/api/sessions/${s.id}/analyze`, { final: true });
    } catch (e) {
      res = { error: errText(e) };
    }
    if (res.status === 409 || res.busy) {
      if (Date.now() < deadline) {
        msg.textContent = "ה-AI מסיים עדכון קודם, ואז יכין את הגרסה הסופית…";
        await sleep(5000);
        continue;
      }
      msg.textContent = "הגרסה הסופית עדיין בעבודה. הקישור יתעדכן לבד, ואפשר לנסות שוב.";
      $("btn-retry-final").classList.remove("hidden");
      return;
    }
    if (res.error) {
      msg.textContent = `הגרסה הסופית לא נוצרה (${res.error}). הקישור מציג את הגרסה האחרונה.`;
      $("btn-retry-final").classList.remove("hidden");
      return;
    }
    if (!res.plan) {
      msg.textContent = "לא נקלט מספיק דיבור עסקי כדי לבנות תוכנית. כדאי לבדוק את המיקרופון ואת הקליטה של הלקוח.";
      return;
    }
    if (res.insights) renderInsights(res.insights);
    msg.textContent = "הגרסה הסופית מוכנה. זה הקישור לתוכנית, גם בשביל המתכנת.";
    return;
  }
}

async function retryFinal() {
  const s = sess;
  if (!s || s.finalizing) return;
  s.finalizing = true;
  $("btn-retry-final").classList.add("hidden");
  $("btn-new").disabled = true;
  $("ended-msg").textContent = "מנסה שוב ליצור את הגרסה הסופית…";
  await finalizeSession(s);
  s.finalizing = false;
  $("btn-new").disabled = false;
}

function cleanupStreams(s) {
  if (!s) return;
  for (const st of s.streams) st.getTracks().forEach((t) => t.stop());
  s.streams = [];
  if (s.audioCtx && s.audioCtx.state !== "closed") s.audioCtx.close();
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
$("client-name").addEventListener("keydown", (e) => e.key === "Enter" && !$("btn-start").disabled && startSession());
$("btn-update").addEventListener("click", () => runAnalyze(true));
$("btn-note").addEventListener("click", sendNote);
$("note").addEventListener("keydown", (e) => e.key === "Enter" && !$("btn-note").disabled && sendNote());
$("btn-end").addEventListener("click", endSession);
$("btn-end-from-banner").addEventListener("click", endSession);
$("btn-keep").addEventListener("click", () => $("call-ended-banner").classList.add("hidden"));
$("btn-loopback-retry").addEventListener("click", retryLoopback);
$("btn-retry-final").addEventListener("click", retryFinal);
$("btn-copy").addEventListener("click", () => sess && live.copy(sess.publicUrl));
$("btn-open").addEventListener("click", () => sess && live.openExternal(sess.publicUrl));
$("btn-copy2").addEventListener("click", () => sess && live.copy(sess.publicUrl));
$("btn-open2").addEventListener("click", () => sess && live.openExternal(sess.publicUrl));
$("btn-new").addEventListener("click", () => {
  if (sess && sess.finalizing) return;
  sess = null;
  $("client-name").value = "";
  $("mic-banner").classList.add("hidden");
  showError("idle-error", null);
  show("idle");
});
$("btn-settings").addEventListener("click", openSettings);
$("btn-save").addEventListener("click", saveSettings);
$("btn-cancel").addEventListener("click", () => show(currentView));

// Clicking the "looks like you're on a call" notification starts listening right away.
live.onPromptStart(({ autoStart } = {}) => {
  if (currentView !== "idle") return;
  if (autoStart) return startSession();
  $("mic-banner").classList.remove("hidden");
  $("client-name").focus();
});
live.onMicActive(({ active }) => {
  if (currentView === "idle") $("mic-banner").classList.toggle("hidden", !active);
});
// Zoom/Meet released the mic a while ago but we're still recording: offer to end.
live.onCallMaybeEnded(() => {
  if (sess && !sess.ended && currentView === "live") $("call-ended-banner").classList.remove("hidden");
});
// Tray "exit" during a call: finish properly first.
live.onEndAndQuit(async () => {
  try {
    if (sess && !sess.ended) await endSession();
  } finally {
    live.quit();
  }
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
    const r = await live.uploadAudio(payload);
    if (r.ok === false) report.uploadErrors.push(String(r.error).slice(0, 160));
    else report.uploads++;
    return r;
  };
  $("client-name").value = "בדיקה עצמית";
  await startSession();
  report.sessionId = sess && sess.id;
  report.loopback = !!(sess && sess.recorders.length === 2);
  report.startError = $("idle-error").classList.contains("hidden") ? null : $("idle-error").textContent;
  if (!sess) return live.selfTestDone(report);
  await sleep(25000);
  await endSession();
  report.endedMessage = $("ended-msg").textContent;
  live.selfTestDone(report);
}

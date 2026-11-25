const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  dialog,
  ipcMain,
  powerSaveBlocker,
  shell,
  clipboard,
  session,
  desktopCapturer,
  nativeImage,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startMicMonitor } = require("./micmonitor");

const APP_ID = "com.proalgorithm.live";
const startHidden = process.argv.includes("--hidden");
// --selftest: records 20s, uploads, ends the session and quits (for checking capture).
const selfTest = process.argv.includes("--selftest");

let win = null;
let tray = null;
let quitting = false;
let recording = false;
let busy = false; // finishing a call: uploads draining and the final version being built
let quitRequested = false;
let sleepBlocker = null;

// ---------- config ----------

// config.build.json (not in git) carries the production server URL and token baked into the installer.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
  } catch {
    return {};
  }
}
const defaults = { ...readJson("config.defaults.json"), ...readJson("config.build.json") };
const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return { ...defaults };
  }
}

/** Stores only what the user changed, so a newer installer's server URL / token still take effect. */
function saveConfig(cfg) {
  let overrides = {};
  try {
    overrides = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    overrides = {};
  }
  Object.assign(overrides, cfg);
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === defaults[key]) delete overrides[key];
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(overrides, null, 2));
  const merged = { ...defaults, ...overrides };
  applyLoginItem(merged);
  return merged;
}

// ---------- call history (this computer only) ----------

const historyPath = () => path.join(app.getPath("userData"), "history.json");
const HISTORY_MAX = 100;
const HISTORY_DAYS = 120; // the server keeps a call about this long

function loadHistory() {
  try {
    const list = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    const cutoff = Date.now() - HISTORY_DAYS * 86400_000;
    return Array.isArray(list) ? list.filter((h) => h && h.id && (h.startedAt || 0) > cutoff) : [];
  } catch {
    return [];
  }
}

/** Adds a call or merges new details (name, end time) into one already listed. Newest first. */
function saveHistory(entry) {
  if (!entry || !entry.id) return loadHistory();
  const list = loadHistory();
  const i = list.findIndex((h) => h.id === entry.id);
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (i >= 0) list[i] = { ...list[i], ...clean };
  else list.unshift(clean);
  list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const out = list.slice(0, HISTORY_MAX);
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    fs.writeFileSync(historyPath(), JSON.stringify(out, null, 2));
  } catch (e) {
    console.warn("history save failed", e);
  }
  return out;
}

function applyLoginItem(cfg) {
  if (!app.isPackaged) return; // don't register the dev electron.exe
  app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin, args: ["--hidden"] });
}

// ---------- server calls (from main, so no CORS issues) ----------

/** Hebrew message for an HTTP failure (the raw server text is technical English). */
function httpMessage(status, serverError) {
  if (status === 401) return "קוד הגישה שגוי (⚙ הגדרות)";
  if (status === 404) return "השיחה לא נמצאה בשרת";
  if (status === 429) return "השרת עמוס כרגע, מנסה שוב";
  if (status >= 500) return "תקלה זמנית בשרת, מנסה שוב";
  return serverError || `שגיאת שרת ${status}`;
}

async function api(method, route, body) {
  const cfg = loadConfig();
  const base = String(cfg.serverUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("לא הוגדרה כתובת שרת");
  let res;
  try {
    res = await fetch(base + route, {
      method,
      headers: { "content-type": "application/json", "x-app-token": cfg.appToken || "" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(310_000), // the server's own limit is 300s
    });
  } catch {
    throw new Error("אין חיבור לשרת. בודק שוב בעוד רגע.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) {
    console.warn("api", route, res.status, data.error);
    throw new Error(httpMessage(res.status, data.error));
  }
  return { status: res.status, ...data };
}

/** Never throws: returns { ok:false, status, error } so the renderer can decide whether to retry. */
async function uploadAudio({ sessionId, speaker, t, buffer, mime }) {
  const cfg = loadConfig();
  const base = String(cfg.serverUrl || "").replace(/\/+$/, "");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(buffer)], { type: mime || "audio/webm" }), "chunk.webm");
  form.append("speaker", speaker);
  form.append("t", String(t));
  let res;
  try {
    res = await fetch(`${base}/api/sessions/${sessionId}/audio`, {
      method: "POST",
      headers: { "x-app-token": cfg.appToken || "" },
      body: form,
      signal: AbortSignal.timeout(70_000),
    });
  } catch {
    return { ok: false, status: 0, error: "אין חיבור לשרת" };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn("upload", res.status, data.error);
    return { ok: false, status: res.status, error: httpMessage(res.status, data.error) };
  }
  return { ok: true, ...data };
}

// ---------- window & tray ----------

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 820,
    minWidth: 400,
    minHeight: 600,
    show: false,
    title: "Pro Algorithm Live",
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: "#0b1040",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep recording when minimized
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"), selfTest ? { query: { selftest: "1" } } : undefined);
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (recording) notify("השיחה עדיין מוקלטת", "האפליקציה ממשיכה לעבוד ברקע. אפשר לפתוח אותה מהאייקון ליד השעון.");
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: recording ? "● מקליט שיחה" : "Pro Algorithm Live", enabled: false },
    { type: "separator" },
    { label: "פתח", click: showWindow },
    {
      label: "התחל שיחה",
      enabled: !recording,
      click: () => {
        showWindow();
        win.webContents.send("prompt-start", { source: "tray" });
      },
    },
    { type: "separator" },
    { label: "יציאה", click: requestQuit },
  ]);
}

/** Quitting mid-call would lose the last minutes and the final version, so finish the call first. */
async function requestQuit() {
  if ((!recording && !busy) || !win) {
    quitting = true;
    return app.quit();
  }
  if (quitRequested) return showWindow(); // already finishing; don't stack dialogs
  quitRequested = true;
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: [recording ? "סיים את השיחה וצא" : "צא כשהגרסה הסופית מוכנה", "ביטול"],
    defaultId: 0,
    cancelId: 1,
    title: "Pro Algorithm Live",
    message: recording ? "שיחה מוקלטת כרגע." : "הגרסה הסופית של התוכנית עדיין נבנית.",
    detail: "לפני היציאה האפליקציה תסיים את השיחה ותכין את הגרסה הסופית של התוכנית.",
  });
  if (response !== 0) {
    quitRequested = false;
    return;
  }
  win.webContents.send("end-and-quit");
  // Hard cap in case the final version hangs (worst case: 90s uploads + 5 min waiting + final pass).
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 12 * 60 * 1000).unref();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  tray = new Tray(img);
  tray.setToolTip("Pro Algorithm Live");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
}

// Windows drops the click handler of a garbage-collected Notification, so keep them alive until used.
const liveNotifications = new Set();

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, "assets", "icon.png") });
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on("click", () => {
    release();
    if (onClick) onClick();
  });
  n.on("close", release);
  n.show();
}

// ---------- mic detection ----------

let stopMicMonitor = null;

function setupMicMonitor() {
  // Our own app also uses the mic while recording; ignore it.
  const ownExe = process.execPath.replace(/\\/g, "#");
  let endedTimer = null;
  stopMicMonitor = startMicMonitor({
    ignore: [ownExe, "electron.exe", "Pro Algorithm Live"],
    onStart: (apps) => {
      clearTimeout(endedTimer);
      endedTimer = null;
      const cfg = loadConfig();
      if (recording || !cfg.micAlerts) return;
      const who = apps.filter(Boolean).slice(0, 2).join(", ");
      notify("נראה שאתה בשיחה", `${who ? `המיקרופון פעיל ב-${who}. ` : ""}לחץ כאן כדי להתחיל לבנות את תוכנית העבודה.`, () => {
        showWindow();
        win.webContents.send("prompt-start", { source: "mic", apps, autoStart: true });
      });
      if (win) win.webContents.send("mic-active", { active: true, apps });
    },
    onStop: () => {
      if (win) win.webContents.send("mic-active", { active: false });
      // Zoom/Meet let go of the mic but we are still recording: after a minute, offer to end the call.
      if (!recording) return;
      clearTimeout(endedTimer);
      endedTimer = setTimeout(() => {
        endedTimer = null;
        if (!recording || !win) return;
        win.webContents.send("call-maybe-ended");
        notify("השיחה הסתיימה?", "האפליקציה עדיין מקליטה. לחץ כאן כדי לסיים ולהכין את הגרסה הסופית.", showWindow);
      }, 60_000);
    },
  });
}

// ---------- capture of computer sound (the client's voice) ----------

function setupMediaHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(["media", "display-capture", "clipboard-sanitized-write"].includes(permission)));
  ses.setDisplayMediaRequestHandler(
    (_req, cb) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => cb({ video: sources[0], audio: "loopback" }))
        .catch(() => cb({}));
    },
    { useSystemPicker: false },
  );
}

// ---------- IPC ----------

function setupIpc() {
  ipcMain.handle("config:get", () => loadConfig());
  ipcMain.handle("config:set", (_e, cfg) => saveConfig(cfg));
  ipcMain.handle("history:list", () => loadHistory());
  ipcMain.handle("history:save", (_e, entry) => saveHistory(entry));
  ipcMain.handle("api", (_e, { method, route, body }) => api(method, route, body));
  ipcMain.handle("audio:upload", (_e, payload) => uploadAudio(payload));
  ipcMain.handle("open-external", (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle("clipboard:write", (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle("recording:set", (_e, value) => {
    recording = !!value;
    // Keep Windows from suspending the app in the middle of a long call.
    if (recording && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!recording && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
    if (tray) {
      tray.setToolTip(recording ? "Pro Algorithm Live – מקליט" : "Pro Algorithm Live");
      tray.setContextMenu(buildTrayMenu());
    }
  });
  ipcMain.handle("busy:set", (_e, value) => {
    busy = !!value;
  });
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:quit", () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle("selftest:done", (_e, report) => {
    console.log("SELFTEST " + JSON.stringify(report));
    quitting = true;
    app.quit();
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.setAppUserModelId(APP_ID);
  app.whenReady().then(() => {
    applyLoginItem(loadConfig());
    setupMediaHandlers();
    setupIpc();
    createWindow();
    createTray();
    setupMicMonitor();
  });
  app.on("before-quit", () => {
    quitting = true;
    if (stopMicMonitor) stopMicMonitor();
  });
  app.on("window-all-closed", (e) => e.preventDefault()); // keep running in the tray
}

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
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

// ---------- config ----------

const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, "config.defaults.json"), "utf8"));
const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return { ...defaults };
  }
}

function saveConfig(cfg) {
  const merged = { ...loadConfig(), ...cfg };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  applyLoginItem(merged);
  return merged;
}

function applyLoginItem(cfg) {
  if (!app.isPackaged) return; // don't register the dev electron.exe
  app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin, args: ["--hidden"] });
}

// ---------- server calls (from main, so no CORS issues) ----------

async function api(method, route, body) {
  const cfg = loadConfig();
  const base = String(cfg.serverUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("לא הוגדרה כתובת שרת");
  const res = await fetch(base + route, {
    method,
    headers: { "content-type": "application/json", "x-app-token": cfg.appToken || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) {
    throw new Error(data.error || `שגיאת שרת ${res.status}`);
  }
  return { status: res.status, ...data };
}

async function uploadAudio({ sessionId, speaker, t, buffer, mime }) {
  const cfg = loadConfig();
  const base = String(cfg.serverUrl || "").replace(/\/+$/, "");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(buffer)], { type: mime || "audio/webm" }), "chunk.webm");
  form.append("speaker", speaker);
  form.append("t", String(t));
  const res = await fetch(`${base}/api/sessions/${sessionId}/audio`, {
    method: "POST",
    headers: { "x-app-token": cfg.appToken || "" },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `שגיאת תמלול ${res.status}`);
  return data;
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
    {
      label: "יציאה",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  tray = new Tray(img);
  tray.setToolTip("Pro Algorithm Live");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, "assets", "icon.png") });
  if (onClick) n.on("click", onClick);
  n.show();
}

// ---------- mic detection ----------

function setupMicMonitor() {
  // Our own app also uses the mic while recording; ignore it.
  const ownExe = process.execPath.replace(/\\/g, "#");
  startMicMonitor({
    ignore: [ownExe, "electron.exe", "Pro Algorithm Live"],
    onStart: (apps) => {
      const cfg = loadConfig();
      if (recording || !cfg.micAlerts) return;
      const who = apps.filter(Boolean).slice(0, 2).join(", ");
      notify(
        "נראה שאתה בשיחה",
        `${who ? `המיקרופון פעיל ב-${who}. ` : ""}ללחוץ כאן כדי להפעיל את בניית תוכנית העבודה?`,
        () => {
          showWindow();
          win.webContents.send("prompt-start", { source: "mic", apps });
        },
      );
      if (win) win.webContents.send("mic-active", { active: true, apps });
    },
    onStop: () => win && win.webContents.send("mic-active", { active: false }),
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
  ipcMain.handle("api", (_e, { method, route, body }) => api(method, route, body));
  ipcMain.handle("audio:upload", (_e, payload) => uploadAudio(payload));
  ipcMain.handle("open-external", (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle("clipboard:write", (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle("recording:set", (_e, value) => {
    recording = !!value;
    if (tray) {
      tray.setToolTip(recording ? "Pro Algorithm Live – מקליט" : "Pro Algorithm Live");
      tray.setContextMenu(buildTrayMenu());
    }
  });
  ipcMain.handle("app:version", () => app.getVersion());
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
  });
  app.on("window-all-closed", (e) => e.preventDefault()); // keep running in the tray
}

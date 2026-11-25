// Detects when another app (Zoom, Teams, Chrome/Meet...) is using the microphone.
//
// Two sources, merged:
// 1. The Windows audio session manager (micwatch.ps1, a long-running helper): lists the
//    processes that hold an active capture session. Works on every current Windows build.
// 2. The CapabilityAccessManager registry entries (LastUsedTimeStop = 0 while in use).
//    Some Windows 11 builds no longer update these, so this is only a fallback.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

function queryRegistryMicApps() {
  return new Promise((resolve) => {
    execFile("reg", ["query", KEY, "/s", "/v", "LastUsedTimeStop"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const active = [];
      let current = null;
      for (const raw of String(stdout).split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("HKEY_")) current = line;
        else if (current && /^LastUsedTimeStop\s+REG_QWORD\s+0x0$/i.test(line)) active.push(appNameFromKey(current));
      }
      resolve(active);
    });
  });
}

/** Friendly app name from a registry key, e.g. "Zoom" or "msedge". */
function appNameFromKey(key) {
  const leaf = key.split("\\").pop() || "";
  if (key.includes("\\NonPackaged\\")) return path.basename(leaf.replace(/#/g, "\\"), ".exe");
  return leaf.split("_")[0];
}

/** Runs micwatch.ps1 and keeps the latest list of apps with an active capture session. */
function startSessionWatcher() {
  const state = { apps: [], updatedAt: 0 };
  let child = null;
  let stopped = false;
  let restarts = 0;

  // PowerShell can't read from inside app.asar, so copy the script out first.
  let script;
  try {
    script = path.join(os.tmpdir(), "proalgo-live-micwatch.ps1");
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, "micwatch.ps1")));
  } catch {
    return { state, stop() {} };
  }

  const run = () => {
    if (stopped) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("MIC|")) continue;
        state.apps = line.slice(4).split(",").map((s) => s.trim()).filter(Boolean);
        state.updatedAt = Date.now();
        restarts = 0;
      }
    });
    child.on("error", () => {});
    child.on("exit", () => {
      child = null;
      state.apps = [];
      if (stopped || restarts >= 5) return;
      restarts++;
      setTimeout(run, 5000 * restarts);
    });
  };
  run();
  return {
    state,
    stop() {
      stopped = true;
      if (child) child.kill();
    },
  };
}

/**
 * Polls every `intervalMs`. Calls onStart(appNames) once when some other app starts
 * using the mic, and onStop() when no other app is using it any more.
 * `ignore` holds names or exe paths of our own app. Returns a stop function.
 */
function startMicMonitor({ intervalMs = 3000, ignore = [], onStart, onStop }) {
  const ignoreNames = ignore.map((s) => path.basename(s.replace(/#/g, "\\"), ".exe").toLowerCase());
  const sessions = startSessionWatcher();
  let wasActive = false;
  const tick = async () => {
    const fromRegistry = await queryRegistryMicApps();
    // Session data older than 10s means the helper is stuck or gone; don't trust it.
    const fromSessions = Date.now() - sessions.state.updatedAt < 10_000 ? sessions.state.apps : [];
    const seen = new Set();
    const others = [];
    for (const name of [...fromSessions, ...fromRegistry]) {
      const low = name.toLowerCase();
      if (!low || ignoreNames.includes(low) || seen.has(low)) continue;
      seen.add(low);
      others.push(name);
    }
    const active = others.length > 0;
    if (active && !wasActive) onStart?.(others.map(prettyName));
    if (!active && wasActive) onStop?.();
    wasActive = active;
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => {
    clearInterval(timer);
    sessions.stop();
  };
}

const PRETTY = { chrome: "Chrome", msedge: "Edge", msedgewebview2: "Teams", "ms-teams": "Teams", mstteams: "Teams", zoom: "Zoom", firefox: "Firefox" };
function prettyName(n) {
  return PRETTY[n.toLowerCase()] || n;
}

module.exports = { startMicMonitor };

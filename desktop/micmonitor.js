// Detects when another app (Zoom, Teams, Chrome/Meet...) is using the microphone.
// Windows records mic usage per app under CapabilityAccessManager; while an app is
// using the mic, its LastUsedTimeStop value is 0.
const { execFile } = require("node:child_process");
const path = require("node:path");

const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

function queryActiveMicApps() {
  return new Promise((resolve) => {
    execFile("reg", ["query", KEY, "/s", "/v", "LastUsedTimeStop"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const active = [];
      let current = null;
      for (const raw of String(stdout).split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("HKEY_")) current = line;
        else if (current && /^LastUsedTimeStop\s+REG_QWORD\s+0x0$/i.test(line)) active.push(current);
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

/**
 * Polls every `intervalMs`. Calls onStart(appNames) once when some other app starts
 * using the mic, and onStop() when no other app is using it any more.
 */
function startMicMonitor({ intervalMs = 3000, ignore = [], onStart, onStop }) {
  let wasActive = false;
  const ignoreLower = ignore.map((s) => s.toLowerCase());
  const tick = async () => {
    const keys = await queryActiveMicApps();
    const others = keys.filter((k) => !ignoreLower.some((ig) => k.toLowerCase().includes(ig)));
    const active = others.length > 0;
    if (active && !wasActive) onStart?.(others.map(appNameFromKey));
    if (!active && wasActive) onStop?.();
    wasActive = active;
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}

module.exports = { startMicMonitor, queryActiveMicApps };

// Automatic updates from the GitHub Releases of fleet-360/proalgo-live.
// A new version downloads in the background and installs itself silently, but only when it can't
// get in the way: no call recording or finishing, nothing done in the app for a while, window not in use.
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");

const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const QUIET_MS = 10 * 60 * 1000; // no call activity for this long before restarting into the update

function flagPath(app) {
  return path.join(app.getPath("userData"), "just-updated.json");
}

/** True (and clears the flag) when this run is the restart right after an automatic update. */
function consumeUpdateFlag(app) {
  try {
    const flag = JSON.parse(fs.readFileSync(flagPath(app), "utf8"));
    fs.rmSync(flagPath(app), { force: true });
    return Date.now() - (flag.at || 0) < 15 * 60 * 1000 ? flag : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {Electron.App} o.app
 * @param {() => {recording:boolean, busy:boolean, lastActivity:number, windowInUse:boolean}} o.state
 * @param {() => void} o.beforeInstall  lets the app drop its "keep running in the tray" guards
 */
function setupAutoUpdate({ app, state, beforeInstall }) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // also covers a normal "exit" from the tray
  autoUpdater.logger = null;

  let readyVersion = null;
  let installing = false;

  const tryInstall = () => {
    if (!readyVersion || installing) return;
    const s = state();
    if (s.recording || s.busy || s.windowInUse) return;
    if (Date.now() - s.lastActivity < QUIET_MS) return;
    installing = true;
    try {
      fs.writeFileSync(flagPath(app), JSON.stringify({ version: readyVersion, at: Date.now() }));
    } catch {
      // only decides whether the restarted app opens hidden
    }
    beforeInstall();
    autoUpdater.quitAndInstall(true, true); // silent install, start the app again afterwards
  };

  autoUpdater.on("update-downloaded", (info) => {
    readyVersion = info.version;
    tryInstall();
  });
  autoUpdater.on("error", (e) => console.warn("auto-update:", e && e.message));

  const check = () => autoUpdater.checkForUpdates().catch((e) => console.warn("auto-update check:", e && e.message));
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  setInterval(tryInstall, 60 * 1000);
}

module.exports = { setupAutoUpdate, consumeUpdateFlag };

// Publishes a new version to GitHub Releases; installed apps pick it up automatically.
//
//   npm run release            -> bumps the patch version (1.3.0 -> 1.3.1)
//   npm run release -- minor   -> 1.3.0 -> 1.4.0
//
// The release is public, so it is built WITHOUT config.build.json (the access code).
// Apps that are already installed keep their code; a fresh install from the public link asks for it once.
// For a ready-to-run installer with the code inside, to hand out privately, use `npm run dist`.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const secret = path.join(root, "config.build.json");
const parked = path.join(root, "config.build.json.parked");

const bump = process.argv[2] || "patch";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const next = bump === "major" ? `${maj + 1}.0.0` : bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

const token = execSync("gh auth token", { encoding: "utf8" }).trim();
if (!token) throw new Error("gh is not signed in (run: gh auth login)");

const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`Commit your changes first, the release is built from what is committed:\n${dirty}`);

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Releasing ${next}…`);
// GitHub only publishes a release for a tag that already exists.
run(`git commit -q -m "Release desktop ${next}" -- package.json`);
run(`git tag v${next}`);
run(`git push -q origin HEAD v${next}`);

if (fs.existsSync(secret)) fs.renameSync(secret, parked);
try {
  run("npx electron-builder --win nsis --x64 --publish always", { GH_TOKEN: token });
  // Last line of defence: the access code must not be in what was just uploaded.
  const asar = path.join(root, "dist", "win-unpacked", "resources", "app.asar");
  const parkedCode = fs.existsSync(parked) ? JSON.parse(fs.readFileSync(parked, "utf8")).appToken : "";
  if (parkedCode && fs.readFileSync(asar).includes(Buffer.from(parkedCode))) {
    throw new Error("The access code ended up in the release build. Delete the release on GitHub right away.");
  }
} finally {
  if (fs.existsSync(parked)) fs.renameSync(parked, secret);
}
console.log(`\nPublished ${next}: https://github.com/fleet-360/proalgo-live/releases/tag/v${next}`);
console.log("Public installer (asks for the access code once):");
console.log(`https://github.com/fleet-360/proalgo-live/releases/latest/download/ProAlgorithmLive-Setup-${next}.exe`);

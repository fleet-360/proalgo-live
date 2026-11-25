// Publishes a new version to GitHub Releases; installed apps pick it up automatically.
//
//   npm run release            -> bumps the patch version (1.3.0 -> 1.3.1)
//   npm run release -- minor   -> 1.3.0 -> 1.4.0
//   npm run release -- resume  -> rebuilds and uploads the current version again (after a failed upload)
//
// The release is public, so it is built WITHOUT config.build.json (the access code).
// Apps that are already installed keep their code; a fresh install from the public link asks for it once.
// For a ready-to-run installer with the code inside, to hand out privately, use `npm run dist`.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "fleet-360/proalgo-live";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkgPath = path.join(root, "package.json");
const secret = path.join(root, "config.build.json");
const parked = path.join(root, "config.build.json.parked");

const mode = process.argv[2] || "patch";
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

if (mode !== "resume") {
  const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
  if (dirty) throw new Error(`Commit your changes first, the release is built from what is committed:\n${dirty}`);
  const [maj, min, pat] = pkg.version.split(".").map(Number);
  pkg.version = mode === "major" ? `${maj + 1}.0.0` : mode === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  // GitHub only publishes a release for a tag that already exists.
  run(`git commit -q -m "Release desktop ${pkg.version}" -- package.json`);
  run(`git tag v${pkg.version}`);
  run(`git push -q origin HEAD v${pkg.version}`);
}
const version = pkg.version;
console.log(`Building ${version} (without the access code)…`);

const parkedCode = fs.existsSync(secret) ? JSON.parse(fs.readFileSync(secret, "utf8")).appToken || "" : "";
if (fs.existsSync(secret)) fs.renameSync(secret, parked);
try {
  run("npx electron-builder --win nsis --x64 --publish never");
  // Last line of defence: the access code must not be in what is about to be uploaded.
  const asar = fs.readFileSync(path.join(dist, "win-unpacked", "resources", "app.asar"));
  if (parkedCode && asar.includes(Buffer.from(parkedCode))) throw new Error("The access code ended up in the release build; not uploading.");
} finally {
  if (fs.existsSync(parked)) fs.renameSync(parked, secret);
}

const exe = `ProAlgorithmLive-Setup-${version}.exe`;
const files = [exe, `${exe}.blockmap`, "latest.yml"].map((f) => path.join(dist, f));
for (const f of files) if (!fs.existsSync(f)) throw new Error(`Missing build output: ${f}`);

const gh = (args) => execFileSync("gh", args, { cwd: root, stdio: "inherit" });
let exists = true;
try {
  execFileSync("gh", ["release", "view", `v${version}`, "-R", REPO], { stdio: "ignore" });
} catch {
  exists = false;
}
if (exists) gh(["release", "upload", `v${version}`, "-R", REPO, "--clobber", ...files]);
else gh(["release", "create", `v${version}`, "-R", REPO, "--title", version, "--notes", `Pro Algorithm Live ${version}`, ...files]);

console.log(`\nPublished ${version}: https://github.com/${REPO}/releases/tag/v${version}`);
console.log("Installed apps update themselves. Public installer for new computers (asks for the access code once):");
console.log(`https://github.com/${REPO}/releases/latest/download/${exe}`);

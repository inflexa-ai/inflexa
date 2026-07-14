"use strict";
// Fallback binary delivery for installs that skipped optionalDependencies
// (--no-optional/--omit=optional, or a node_modules/lockfile carried across
// operating systems): downloads this exact version's binary from the GitHub
// release and verifies it against the release's SHA256SUMS — the file the
// release workflow generated and attested — before placing it in
// bin-fallback/ for the launcher.
//
// Failures warn and exit 0 instead of failing the whole `npm install`: a
// missing binary is only fatal when inflexa is actually invoked (the
// launcher prints recovery steps), while a hard postinstall failure would
// block installing any dependency tree that merely includes inflexa —
// e.g. on a platform we don't build for at all.
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "inflexa-ai/inflexa";

// npm platform key -> release asset name (npm says win32 where the release
// assets say windows).
const ASSETS = {
  "darwin-arm64": "inflexa-darwin-arm64",
  "darwin-x64": "inflexa-darwin-x64",
  "linux-x64": "inflexa-linux-x64",
  "win32-x64": "inflexa-windows-x64.exe",
};

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const binName = process.platform === "win32" ? "inflexa.exe" : "inflexa";

  // Fast path: the platform optionalDependency delivered the binary, nothing
  // to download.
  try {
    require.resolve(`@inflexa-ai/inflexa-${key}/package.json`);
    return;
  } catch {
    // fall through to the download
  }

  const asset = ASSETS[key];
  if (!asset) {
    console.warn(`inflexa: no prebuilt binary exists for ${key}; the inflexa command will not run on this platform.`);
    return;
  }

  const version = require(path.join(__dirname, "package.json")).version;
  const base = `https://github.com/${REPO}/releases/download/v${version}`;

  const binRes = await fetch(`${base}/${asset}`);
  if (!binRes.ok) throw new Error(`download failed (HTTP ${binRes.status}): ${base}/${asset}`);
  const bin = Buffer.from(await binRes.arrayBuffer());

  const sumsRes = await fetch(`${base}/SHA256SUMS`);
  if (!sumsRes.ok) throw new Error(`download failed (HTTP ${sumsRes.status}): ${base}/SHA256SUMS`);
  const sums = await sumsRes.text();
  let expected = null;
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset) {
      expected = hash;
      break;
    }
  }
  if (!expected) throw new Error(`${asset} is not listed in the release's SHA256SUMS`);
  const actual = createHash("sha256").update(bin).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset} — expected ${expected}, got ${actual}`);

  // Stage-then-rename so the launcher never sees a half-written binary.
  const dir = path.join(__dirname, "bin-fallback");
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `.${binName}.tmp`);
  fs.writeFileSync(staged, bin, { mode: 0o755 });
  fs.renameSync(staged, path.join(dir, binName));
  console.log(`inflexa: optionalDependencies were skipped — downloaded and verified ${asset} instead`);
}

main().catch(function (err) {
  console.warn(`inflexa: postinstall fallback failed: ${err.message}`);
  console.warn("inflexa: the inflexa command will not run until its binary is available — reinstall without --no-optional, or see https://github.com/inflexa-ai/inflexa");
});

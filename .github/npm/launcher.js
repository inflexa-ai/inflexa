#!/usr/bin/env node
"use strict";
// The @inflexa-ai/inflexa `bin`: resolves and executes the platform-native
// binary delivered by one of the @inflexa-ai/inflexa-<platform>-<arch>
// optionalDependencies, falling back to the copy postinstall.js downloaded
// when optional dependencies were skipped. The `bin` stays a Node script —
// pointing it at the raw executable breaks the shims npm/pnpm/bun generate
// on Windows.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function resolveBinary() {
  if (process.env.INFLEXA_BIN_PATH) return process.env.INFLEXA_BIN_PATH;
  const binName = process.platform === "win32" ? "inflexa.exe" : "inflexa";
  // TODO(extend): pick a -musl platform package on musl libc once those
  // binaries ship (inflexa-ai/inflexa#107).
  const pkg = `@inflexa-ai/inflexa-${process.platform}-${process.arch}`;
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(pkgJson), "bin", binName);
  } catch {
    const fallback = path.join(__dirname, "..", "bin-fallback", binName);
    if (fs.existsSync(fallback)) return fallback;
    return null;
  }
}

const bin = resolveBinary();
if (!bin) {
  console.error(
    [
      `inflexa: no binary available for ${process.platform}-${process.arch}.`,
      "The platform package (an optionalDependency) was not installed, and the",
      "postinstall fallback did not deliver a binary either. Reinstall without",
      "--no-optional/--omit=optional/--ignore-scripts, or install the platform",
      `package directly: npm install @inflexa-ai/inflexa-${process.platform}-${process.arch}`,
    ].join("\n"),
  );
  process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`inflexa: failed to start ${bin}: ${result.error.message}`);
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 0);

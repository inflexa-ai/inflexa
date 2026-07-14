// Post-build smoke test: the published artifact must actually *load* under
// Node before it may ship. A type-correct `tsc` build can still be
// runtime-broken — a relative import missing its `.js` extension, a path that
// resolves under bun but not Node, a dependency that throws at import time —
// and bun (the dev/test runtime here) is more permissive than the Node
// resolver consumers actually use. This loads the exact file the `exports`
// map's `.` entry points at and checks the embedder-facing surface is
// present, exiting non-zero so `prepublishOnly` and the release workflow
// refuse to publish a broken build.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const distEsm = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

try {
  console.log("smoke: loading dist/index.js under node…");
  const mod = await import(pathToFileURL(distEsm).href);

  // The embedder-facing composition surface. A barrel that loads but lost its
  // re-exports (e.g. a bad emit of src/index.ts) fails here rather than in a
  // consumer's composition root.
  const required = [
    "assembleCoreRuntime",
    "createConversationAgent",
    "createDbosRunLauncher",
    "defineTool",
    "runAgent",
  ];
  const missing = required.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`dist/index.js loaded, but exports are missing or not functions: ${missing.join(", ")}`);
  }

  console.log(`smoke: OK — barrel loads under node, ${required.length} embedder-facing exports present.`);
} catch (err) {
  console.error("smoke: FAILED —", err?.stack ?? err);
  process.exit(1);
}

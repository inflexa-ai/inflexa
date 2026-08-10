// Post-build smoke test: the published artifact must actually *load* under
// Node before it may ship. A type-correct `tsc` build can still be
// runtime-broken — a relative import missing its `.js` extension, a path that
// resolves under bun but not Node, a dependency that throws at import time —
// and bun (the dev/test runtime here) is more permissive than the Node
// resolver consumers actually use. This loads the exact file the `exports`
// map's `.` entry points at, derives one QName, and runs one sign/verify
// roundtrip, exiting non-zero so `prepublishOnly` and the release workflow
// refuse to publish a broken build.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const distEsm = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

try {
  console.log("smoke: loading dist/index.js under node…");
  const mod = await import(pathToFileURL(distEsm).href);

  const required = [
    "createProvDocumentModel",
    "defaultProvDigest",
    "deriveLineageModel",
    "createKeypairSigner",
    "computeChainHash",
    "buildAttestation",
    "verifyAttestation",
  ];
  const missing = required.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`dist/index.js loaded, but exports are missing or not functions: ${missing.join(", ")}`);
  }

  // One QName derivation through the default digest.
  const model = mod.createProvDocumentModel();
  const qn = model.fileQName({ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" });
  if (!/^inflexa:file-[0-9a-z]+$/.test(qn)) {
    throw new Error(`fileQName produced an unexpected shape: ${qn}`);
  }

  // One sign/verify roundtrip through the attestation path.
  const keypair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signer = mod.createKeypairSigner(keypair);
  const provJson = `{"prefix":{"inflexa":"https://inflexa.ai/prov#"}}`;
  const attestationResult = await mod.buildAttestation(signer, provJson);
  if (attestationResult.isErr()) {
    throw new Error(`buildAttestation failed: ${JSON.stringify(attestationResult.error)}`);
  }
  const verdict = await mod.verifyAttestation(provJson, attestationResult.value);
  if (verdict.status !== "valid") {
    throw new Error(`attestation roundtrip did not verify: ${JSON.stringify(verdict)}`);
  }

  console.log(`smoke: OK — barrel loads under node, QName derivation and sign/verify roundtrip pass.`);
} catch (err) {
  console.error("smoke: FAILED —", err?.stack ?? err);
  process.exit(1);
}

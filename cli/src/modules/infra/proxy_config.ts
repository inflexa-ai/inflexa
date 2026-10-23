import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type Result, ok, err } from "neverthrow";
import { z } from "zod";
import { env } from "../../lib/env.ts";
import { classifyPath, ensureFileMountSource, tryFs, type InfraStateError } from "./mount_source.ts";

// The CLIProxyAPI proxy config (`config.yaml`) and the provider-credential dir are host-side state we
// own; the compose stack bind-mounts them into the proxy container. This module provisions the config
// file and is imported by BOTH setup.ts (the interactive flow) and compose.ts (the mount-source
// integrity guard baked into the compose-up seam) — the multi-caller threshold that earns it a file of
// its own. It sits BELOW compose.ts in the import graph (compose imports it, never the reverse): the
// provisioner cannot live in setup.ts, because setup.ts already imports compose.ts, so a provisioner
// there would force a compose→setup back-edge the seam design exists to avoid. The classify/heal
// skeleton it runs on is shared with the SearXNG settings provisioner and lives in mount_source.ts.

/**
 * In-container path of the provider-credential dir, mounted from {@link env.cliproxyAuthDir}. Embedded
 * verbatim in the generated config so the proxy reads credentials from the mount. It is a Linux path
 * (the container filesystem), OS-independent of the host.
 */
const CONTAINER_AUTH_DIR = "/root/.cli-proxy-api";

/**
 * Outcome of {@link writeProxyConfig}: a fresh write yields the minted client key so the caller can show
 * it once; an existing file was left untouched and carries nothing. A discriminated union (not an
 * optional `apiKey`) so the key is only reachable on the branch that produced it.
 */
export type WriteProxyConfigOutcome = { created: false; managementAdded: boolean } | { created: true; apiKey: string };

/**
 * Provision the proxy config file, converging any partial or damaged state to a correct file:
 *
 * - absent          → write the config with a freshly minted client key (`created: true`)
 * - existing file   → kept (`created: false`). The one rewrite gives the file a management key when the
 *   CLI holds none ({@link ensureManagementKey}), and `managementAdded` then tells the caller to restart a
 *   running proxy
 * - EMPTY directory → the engine-manufactured artifact (a missing bind-mount source the container engine
 *   created as a directory): healed by {@link ensureFileMountSource}, then the file is written
 * - anything else   → `path_occupied`; the CLI refuses to delete state it did not just create
 *
 * The parent config dir and the credential dir are ensured (0700) first; the file is written 0600. Every
 * failure travels the `Result` channel — this function never throws, so callers translate known causes
 * into remediation instead of a raw errno reaching them through a backstop.
 */
export async function writeProxyConfig(): Promise<Result<WriteProxyConfigOutcome, InfraStateError>> {
    const configPath = env.cliproxyConfigPath;
    const configDir = dirname(configPath);

    const parent = await tryFs(configDir, () => mkdir(configDir, { recursive: true, mode: 0o700 }));
    if (parent.isErr()) return err(parent.error);
    const auth = await tryFs(env.cliproxyAuthDir, () => mkdir(env.cliproxyAuthDir, { recursive: true, mode: 0o700 }));
    if (auth.isErr()) return err(auth.error);

    return ensureFileMountSource(
        configPath,
        async () => (await ensureManagementKey(configPath)).map((managementAdded): WriteProxyConfigOutcome => ({ created: false, managementAdded })),
        () => writeFreshConfig(configPath),
    );
}

/**
 * The proxy's per-credential cloak switch for Claude OAuth. The default `auto` sent our AI SDK requests
 * upstream with their own User-Agent and system prompt, and Anthropic answered them with a 429; `always`
 * disguises every client that is not Claude Code. The proxy keeps the field when it rewrites the file on
 * a token refresh, so only a fresh login (which writes a new file) drops it.
 */
const CLAUDE_CLOAK_MODE = "always";

const credentialObjectSchema = z.record(z.string(), z.unknown());

/**
 * Set `cloak_mode` on every Claude credential file in `dir` that lacks it, and report whether any file
 * changed. A running proxy never sees a host write to the mounted dir, so a `true` means the caller must
 * restart a proxy that is already up. Each file is replaced through a rename because the container
 * engine can own the original as root, while the dir itself is ours.
 */
export async function enforceClaudeCloak(dir: string): Promise<Result<boolean, InfraStateError>> {
    const names = await tryFs(dir, () => readdir(dir));
    if (names.isErr()) return err(names.error);
    let changed = false;
    for (const name of names.value) {
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const path = join(dir, name);
        const text = await tryFs(path, () => readFile(path, "utf8"));
        if (text.isErr()) return err(text.error);
        const credential = JSON.parseWith(text.value, credentialObjectSchema);
        if (credential === null || credential.type !== "claude" || credential.cloak_mode === CLAUDE_CLOAK_MODE) continue;
        // Dot-prefixed so neither the proxy nor hasProviderCredential reads the half-written file as a credential.
        const tmp = join(dir, `.${name}.tmp`);
        const written = await tryFs(tmp, () => writeFile(tmp, JSON.stringify({ ...credential, cloak_mode: CLAUDE_CLOAK_MODE }), { mode: 0o600 }));
        if (written.isErr()) return err(written.error);
        const moved = await tryFs(path, () => rename(tmp, path));
        if (moved.isErr()) return err(moved.error);
        changed = true;
    }
    return ok(changed);
}

/** Mint a client key and write the config 0600. Shared by the absent and healed paths. */
async function writeFreshConfig(path: string): Promise<Result<WriteProxyConfigOutcome, InfraStateError>> {
    const apiKey = generateApiKey();
    const managementKey = generateApiKey();
    const keyWritten = await tryFs(managementKeyPath(), () => writeFile(managementKeyPath(), managementKey, { mode: 0o600 }));
    if (keyWritten.isErr()) return err(keyWritten.error);
    const written = await tryFs(path, () => writeFile(path, proxyConfig(apiKey, managementKey), { mode: 0o600 }));
    return written.map(() => ({ created: true, apiKey }));
}

/**
 * Where the CLI keeps the plaintext management key. The proxy replaces the plaintext in config.yaml with
 * a bcrypt hash at boot, so config.yaml alone cannot give the key back.
 */
export function managementKeyPath(): string {
    return join(dirname(env.cliproxyConfigPath), "management.key");
}

/**
 * Give a config from before the management API a management key, and report whether the file changed.
 * A config that has a key the CLI cannot read (a lost key file, or a hand edit) gets a new key. The edit
 * is textual, because a YAML round trip drops the quotes that {@link readApiKey} matches on, and it
 * writes in place, because a rename breaks the file bind mount of a running proxy.
 */
async function ensureManagementKey(configPath: string): Promise<Result<boolean, InfraStateError>> {
    const keyPath = managementKeyPath();
    const existing = await classifyPath(keyPath);
    if (existing.isErr()) return err(existing.error);
    const text = await tryFs(configPath, () => readFile(configPath, "utf8"));
    if (text.isErr()) return err(text.error);
    const hasBlock = /^remote-management:/m.test(text.value);
    if (existing.value.kind === "file" && hasBlock) return ok(false);

    const key = generateApiKey();
    let next: string;
    if (!hasBlock) {
        next = `${text.value.replace(/\n*$/, "\n")}${managementBlock(key)}`;
    } else if (/^\s+secret-key:.*$/m.test(text.value)) {
        next = text.value.replace(/^(\s+secret-key:).*$/m, `$1 "${key}"`);
    } else {
        next = text.value.replace(/^remote-management:.*$/m, `remote-management:\n  secret-key: "${key}"`);
    }
    const keyWritten = await tryFs(keyPath, () => writeFile(keyPath, key, { mode: 0o600 }));
    if (keyWritten.isErr()) return err(keyWritten.error);
    const written = await tryFs(configPath, () => writeFile(configPath, next));
    return written.map(() => true);
}

/**
 * The proxy serves the management API on its one port. `allow-remote: false` accepts only a request from
 * inside the container, because the published port delivers host traffic from the bridge gateway. Thus
 * only `docker exec` reaches it. The control panel stays off, so the proxy never downloads it.
 */
function managementBlock(key: string): string {
    return `remote-management:
  allow-remote: false
  secret-key: "${key}"
  disable-control-panel: true
`;
}

/**
 * auth-dir is the in-container Linux path (mounted from env.cliproxyAuthDir), so
 * it is OS-safe regardless of the host.
 */
export function proxyConfig(apiKey: string, managementKey: string): string {
    return `host: ""
port: ${env.cliproxyPort}
auth-dir: "${CONTAINER_AUTH_DIR}"
api-keys:
  - "${apiKey}"
debug: false
${managementBlock(managementKey)}`;
}

/**
 * Client-facing key for calling the proxy — distinct from the provider
 * credentials the login flows write under auth-dir.
 */
export function generateApiKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const rand = new Uint8Array(45);
    crypto.getRandomValues(rand);
    let key = "sk-";
    for (const b of rand) key += chars[b % chars.length];
    return key;
}

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type Result, ok, err } from "neverthrow";
import { env } from "../../lib/env.ts";
import { ensureFileMountSource, publishFileExclusively, tryFs, type InfraStateError } from "./mount_source.ts";

// The SearXNG settings file (`settings.yml`) is host-side state the CLI owns; the compose stack
// bind-mounts it read-only into the searxng container. The engine cannot run on its defaults: the
// container stops on the shipped `ultrasecretkey`, and `format=json` is refused with 403 unless the
// settings list it (docs/web-search-research.md §4). So this provisioner runs through the same
// mount-source guard as the proxy config, before the engine starts in every connection mode. It sits
// BELOW compose.ts in the import graph, on the shared classify/heal machinery of mount_source.ts.

/**
 * Provision the SearXNG settings file at {@link env.searxngSettingsPath}, converging any partial or
 * damaged state to a correct file:
 *
 * - absent          → write the canonical settings with a freshly minted `secret_key`
 * - existing file   → kept untouched, whatever it holds. The one generated value is the key, minted
 *   once: a new key each run would churn a file the user may inspect, and the file is the user's to
 *   edit after the first run — the guard's job is existence, not content policing
 * - EMPTY directory → the engine-manufactured artifact: healed by {@link ensureFileMountSource}, then
 *   the file is written
 * - anything else   → `path_occupied`; the CLI refuses to delete state it did not just create
 *
 * The parent settings dir is ensured (0700) first; the file is written 0600.
 */
export async function writeSearxngSettings(): Promise<Result<void, InfraStateError>> {
    const settingsPath = env.searxngSettingsPath;
    const settingsDir = dirname(settingsPath);

    const made = await tryFs(settingsDir, () => mkdir(settingsDir, { recursive: true, mode: 0o700 }));
    if (made.isErr()) return err(made.error);

    return ensureFileMountSource(
        settingsPath,
        async () => ok(undefined),
        () => writeFreshSettings(settingsPath),
    );
}

/**
 * The first write: mint the one-time key and land the canonical settings through a per-call temp file
 * published exclusively ({@link publishFileExclusively}), so a half-written file is never observable
 * and a concurrent first write can never replace a key that already landed.
 */
async function writeFreshSettings(path: string): Promise<Result<void, InfraStateError>> {
    const published = await publishFileExclusively(path, (tmp) =>
        tryFs(tmp, () => writeFile(tmp, searxngSettings(randomBytes(32).toString("hex")), { mode: 0o600 })),
    );
    return published.map((): void => undefined);
}

/**
 * The canonical settings. `use_default_settings` inherits everything else from the engine's own
 * defaults; the four deltas are what the stack needs: a private non-rate-limited instance (no Valkey
 * service), a `secret_key` that is not the shipped one the container refuses, and `json` among the
 * accepted search formats (the tool reads the JSON API; an unlisted format gets 403).
 */
function searxngSettings(secretKey: string): string {
    return `use_default_settings: true
server:
  secret_key: "${secretKey}"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
`;
}

/**
 * Start the service over one snapshot.
 *
 *   bun src/service/main.ts [--snapshot path.sqlite] [--port 8790] [--host 127.0.0.1]
 *
 * With no `--snapshot`, the server reads `dist/snapshots/latest.json`. The
 * bearer key comes from `INFLEXA_KNOWLEDGE_SERVICE_KEY`. An empty key runs
 * the service open, which is the local development state and never a
 * deployment state.
 */

import { join } from "node:path";

import { openSnapshot } from "../store.js";
import { createService } from "./server.js";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveSnapshotPath(): Promise<string> {
    const explicit = argument("--snapshot");
    if (explicit) return explicit;
    const dir = join(import.meta.dir, "..", "..", "dist", "snapshots");
    const latest = await Bun.file(join(dir, "latest.json")).json();
    return join(dir, latest.path as string);
}

const snapshotPath = await resolveSnapshotPath();
const snapshot = openSnapshot(snapshotPath);
const apiKey = Bun.env.INFLEXA_KNOWLEDGE_SERVICE_KEY || undefined;
const port = Number(argument("--port") ?? Bun.env.PORT ?? 8790);
const hostname = argument("--host") ?? Bun.env.HOST ?? "127.0.0.1";

const server = createService({ snapshot, apiKey, port, hostname }).listen();
console.log(`knowledge service on http://${server.hostname}:${server.port}  snapshot ${snapshot.meta.date} ${snapshot.meta.digest}  auth ${apiKey ? "bearer" : "open"}`);

import { deliverExecEvent, workflowIdFromExec, type ExecEventMessage } from "@inflexa-ai/harness";
import { ok, err, type Result } from "neverthrow";
import { getLogger } from "../../lib/log.ts";

// The exec-callback ingress — used ONLY in callback transport mode. It is the
// HTTP endpoint sandbox-server POSTs signed callbacks to
// (`{CORTEX_BASE_URL}/sandbox/{execId}/{event|complete}`,
// images/sandbox-base/server/callback.go). The route is deliberately DUMB — it
// preserves the raw body bytes and forwards the signature headers verbatim onto
// the per-exec DBOS topic; HMAC verification happens in the workflow-body recv
// loop, which holds the per-sandbox secret. This listener never sees a secret,
// so a forged POST costs an attacker nothing here and dies in `awaitExec`.
//
// The local CLI runs in POLL mode, where the sandbox initiates nothing and there
// is no callback to receive — so it binds no ingress ({@link noopExecIngress}).
// This listener exists for embedders that opt into callback mode.

/** A running ingress listener plus the URL sandbox containers reach it under. */
export type ExecIngress = {
    /** Loopback port actually bound (ephemeral — chosen by the OS); 0 for the no-op poll-mode ingress. */
    readonly port: number;
    /**
     * The upstream this ingress is reachable at, advertised to the sandbox as
     * `CORTEX_BASE_URL` in callback mode. `host.docker.internal` resolves to the
     * host on Docker Desktop even for loopback-bound listeners. Empty for the
     * no-op poll-mode ingress (poll mode advertises no callback URL).
     *
     * Callback mode on native Linux Docker Engine has no `host.docker.internal`
     * and cannot reach a host loopback listener from a container; poll mode is the
     * answer for local Linux, and callback-on-native-Linux remains a documented
     * caveat (inflexa-ai/inf-cli#27).
     */
    readonly cortexBaseUrl: string;
    /** Close the listener, dropping in-flight connections. No-op for the poll-mode ingress. */
    readonly stop: () => void;
};

/**
 * The poll-mode ingress: a no-op. Poll mode receives no callbacks, so there is
 * no listener to bind — but the boot flow still expects an {@link ExecIngress}
 * handle, so hand it one that binds nothing, advertises no URL, and stops
 * cleanly.
 */
export function noopExecIngress(): ExecIngress {
    return { port: 0, cortexBaseUrl: "", stop: () => {} };
}

export type IngressError = { type: "ingress_bind_failed"; cause: unknown };

/** Injectable delivery seam — tests capture envelopes instead of touching DBOS. */
export type DeliverFn = (workflowId: string, execId: string, message: ExecEventMessage) => Promise<void>;

/**
 * Handle one callback POST. Exported for tests — `startExecIngress` wires it
 * into `Bun.serve`. Status mapping follows the sandbox-server's retry contract
 * (callback.go: 2xx done, 4xx give-up, else retry with backoff):
 * - non-POST / unroutable path → 404, malformed execId or body → 400 (permanent),
 * - failed topic delivery → 502 (retryable; DBOS may be mid-launch).
 */
export async function handleExecCallback(req: Request, deliver: DeliverFn): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 404 });
    // execId itself contains colons and dashes but never slashes, so the greedy
    // middle group is unambiguous with the fixed first and last segments.
    const match = new URL(req.url).pathname.match(/^\/sandbox\/(.+)\/(event|complete)$/);
    if (!match) return new Response(null, { status: 404 });
    const [, execId, kind] = match;

    const workflowId = workflowIdFromExec(execId!);
    if (workflowId === null) return new Response("unroutable execId", { status: 400 });

    const raw = await req.text();
    let parsed: unknown; // JSON of unknown shape by design — the workflow validates it after HMAC verification
    try {
        parsed = JSON.parse(raw);
    } catch {
        return new Response("body is not JSON", { status: 400 });
    }

    // `/complete` bodies are the bare ExecResult JSON; the recv loop expects the
    // done-marker wrapper around it. The signature covers the RAW bytes, which
    // ride separately in `payloadRaw` — wrapping `payload` does not break HMAC.
    const payload = kind === "complete" ? { done: true, result: parsed } : parsed;

    const timestampHeader = req.headers.get("x-sandbox-timestamp");
    const timestamp = timestampHeader === null ? null : Number.parseInt(timestampHeader, 10);
    const envelope: ExecEventMessage = {
        payload,
        payloadRaw: raw,
        signature: req.headers.get("x-sandbox-signature"),
        // An unparseable timestamp forwards as null → the recv loop treats the
        // message as unsigned and hard-cancels; do not guess a wall-clock here.
        timestamp: timestamp === null || Number.isNaN(timestamp) ? null : timestamp,
    };

    try {
        await deliver(workflowId, execId!, envelope);
    } catch (cause) {
        getLogger("harness").warn({ execId, kind, err: cause instanceof Error ? cause.message : String(cause) }, "exec callback delivery failed");
        return new Response("delivery failed", { status: 502 });
    }
    return new Response(null, { status: 200 });
}

/**
 * Bind the callback listener on an ephemeral loopback port (callback mode only).
 * Loopback-only (`127.0.0.1`) so the endpoint is reachable ONLY from this host —
 * never the LAN — which matters because the route is intentionally secret-less
 * and defers HMAC verification to the recv loop. Docker Desktop forwards
 * containers to a loopback listener via `host.docker.internal`; callback on
 * native Linux is the documented caveat on {@link ExecIngress.cortexBaseUrl}
 * (poll mode is the local-Linux answer).
 */
export function startExecIngress(deliver: DeliverFn = deliverExecEvent): Result<ExecIngress, IngressError> {
    try {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (req) => handleExecCallback(req, deliver),
        });
        // `port` is typed optional because unix-socket servers have none; a TCP
        // bind always yields one, so its absence means the bind itself is broken.
        if (server.port === undefined) {
            void server.stop(true);
            return err({ type: "ingress_bind_failed", cause: new Error("Bun.serve returned no port for a TCP listener") });
        }
        return ok({
            port: server.port,
            cortexBaseUrl: `http://host.docker.internal:${server.port}`,
            stop: () => void server.stop(true),
        });
    } catch (cause) {
        return err({ type: "ingress_bind_failed", cause });
    }
}

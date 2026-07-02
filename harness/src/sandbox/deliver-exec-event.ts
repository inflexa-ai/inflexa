/**
 * Ingress-side delivery of a sandbox-server callback onto the per-exec DBOS
 * topic (`awaitExec`'s recv loop, `await-exec.ts`).
 *
 * Exists so an embedder hosting the HTTP callback endpoint never touches the
 * DBOS SDK itself: `DBOS` is module-singleton state, and an embedder with its
 * own `node_modules` would import a SECOND, un-launched SDK instance whose
 * `send` writes nowhere. Routing delivery through the harness pins the call to
 * the same instance `launchDbos` initialized — and keeps the topic-name format
 * beside its consumer instead of duplicated in every host.
 *
 * HMAC verification is deliberately NOT done here: `awaitExec` verifies inside
 * the workflow body against the per-sandbox `callbackSecret`, so the ingress
 * stays secret-free and a forged POST is rejected where the secret lives.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ExecEventMessage } from "./types.js";

/** Topic `awaitExec` listens on for one exec's events and done-marker. */
export function execEventTopic(execId: string): string {
    return `exec-event:${execId}`;
}

/**
 * Send one callback envelope (an event, or a `DoneMarker`-shaped completion
 * payload) to the workflow awaiting `execId`. The caller derives
 * `workflowId` via `workflowIdFromExec` and owns HTTP status mapping:
 * a rejection here is retryable (5xx), a malformed execId is not (4xx).
 */
export async function deliverExecEvent(workflowId: string, execId: string, message: ExecEventMessage): Promise<void> {
    await DBOS.send(workflowId, message, execEventTopic(execId));
}

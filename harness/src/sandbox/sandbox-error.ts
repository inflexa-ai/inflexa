/**
 * Sandbox Result glue for cortex.
 *
 * The sandbox backend boundaries — the Docker SDK ops (`docker-client.ts`) and
 * the K8s client ops (`k8s-client.ts`) — model failure as values: each external
 * op returns `ResultAsync<T, SandboxError>`. The ONLY `try/catch` against the
 * SDK/driver call lives in those files (via the `trySandbox` helper here);
 * everything up to the composition seam flows `ResultAsync`. (`submitExec`
 * (`submit-exec.ts`) is NOT on this channel — it wraps its own `/exec` POST in a
 * `DBOS.runStep` and throws on a non-202 so the step boundary records the
 * failure.)
 *
 * House rules realized here (see `lib/result.ts`):
 *  - Absence / "already gone" is NOT an error. A 404 on inspect/isAlive is the
 *    OK-channel fact `ok(false)`; a 404 on teardown is a successful idempotent
 *    teardown `ok(undefined)`; a 409 name-conflict that the owner-guard adopts
 *    is the OK-channel outcome of create. `SandboxError` is reserved for a
 *    genuine failure — a create that cannot complete, a name-collision the
 *    owner-guard REFUSES, a submit the server rejects, a teardown the driver
 *    errors on, a liveness probe that errors.
 *  - Control-flow exceptions are NOT failures and are never captured as a
 *    `SandboxError`. The recv loop's `HardCancelError` / `ExecTimeoutError`
 *    (`await-exec.ts`) and DBOS's `DBOSWorkflowCancelledError` / `AbortError`
 *    are control-flow signalling — they live OUTSIDE this error channel and
 *    propagate untouched. `await-exec.ts` is NOT converted; `trySandbox` only
 *    ever wraps the single SDK/HTTP call handed to it.
 *
 * The public `SandboxClient` interface keeps `Promise<T>` method signatures.
 * `create-sandbox.ts` is the composition seam: it builds the backend ops, maps
 * each `err` of an op to a `SandboxFailure`, and `unwrapOrThrow`s it, so the
 * seam throws the described failure with the variant on `.cause` and on
 * `.error`. A `catch` never sees the raw variant. (`submitExec` is the
 * exception — it is already its own DBOS step and throws directly, so the seam
 * forwards its `Promise<void>` as-is.)
 * Workflow consumers (`sandbox-step.ts`) already wrap each seam call in
 * `DBOS.runStep`, so the re-thrown error records the step as failed;
 * non-workflow consumers (`reaper`, `watchdog`,
 * `data-profile`, `run-exec`) already handle a thrown failure. They are
 * untouched by this wave.
 */

import { ResultAsync, err, ok } from "neverthrow";
import { ZodError } from "zod";

import type { DomainError } from "../lib/result.js";
import type { FarmLockError } from "./farm.js";

/**
 * A sandbox backend failure. Absence / idempotent "already gone" is NOT
 * modelled — those ride the OK channel (`ok(false)` for a dead/missing machine,
 * `ok(undefined)` for a teardown that found nothing to remove). `op` is a
 * stable label (e.g. `"docker.createSandbox"`); `sandboxId` is carried when the
 * op knows it. `status` carries the originating HTTP status when one exists.
 */
export type SandboxError =
    | {
          readonly type: "container_create_failed";
          readonly op: string;
          readonly sandboxId?: string;
          readonly status?: number;
          readonly cause: unknown;
      }
    | {
          readonly type: "name_conflict";
          readonly op: string;
          readonly sandboxId: string;
          readonly owner: string | null;
          readonly cause?: unknown;
      }
    | {
          readonly type: "not_found";
          readonly op: string;
          readonly sandboxId?: string;
          readonly cause?: unknown;
      }
    | {
          readonly type: "submit_failed";
          readonly op: string;
          readonly execId: string;
          readonly status?: number;
          readonly cause: unknown;
      }
    | {
          readonly type: "teardown_failed";
          readonly op: string;
          readonly sandboxId?: string;
          readonly status?: number;
          readonly cause: unknown;
      }
    | {
          readonly type: "liveness_failed";
          readonly op: string;
          readonly sandboxId?: string;
          readonly status?: number;
          readonly cause: unknown;
      }
    | {
          /**
           * The farm source refused the analysis: the resolver returned
           * `unavailable`, or it threw. `reason` carries the text of the
           * embedder verbatim, thus the surface can show why the farm is
           * not usable yet.
           */
          readonly type: "farm_unavailable";
          readonly op: string;
          readonly analysisId: string;
          readonly reason: string;
          readonly cause?: unknown;
      }
    | {
          /**
           * The gate proved the `inflexa.lock` at the resolved farm and the
           * farm is not usable. Raised only when the config declares
           * `packageStore: "required"`; without the fact the same gate
           * failure degrades to no store mount. The sibling
           * `farm_unavailable` is the resolver refusing to name a farm at
           * all — here a farm was named, and its lock does not hold up.
           */
          readonly type: "farm_unusable";
          readonly op: string;
          readonly analysisId: string;
          readonly farmPath: string;
          readonly lockPath: string;
          readonly lockError: FarmLockError["type"];
          readonly cause: unknown;
      };

// SandboxError is a `DomainError` (string `type` + `cause`) — the compile-time
// check keeps it inside the cross-subsystem error vocabulary.
type _AssertDomainError = SandboxError extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

/**
 * The HTTP/driver status a backend SDK error carries. dockerode exposes it on
 * `.statusCode`; `@kubernetes/client-node` (v1.x) on `.code` (a number).
 * Mirror the per-client `statusCodeOf` so 404/409 classification is identical.
 * A Node system error (`code: "ECONNREFUSED"`) has a string `code`, so guard on
 * `typeof === "number"` to avoid returning it as a status.
 */
export function sandboxStatusOf(cause: unknown): number | undefined {
    const e = cause as {
        code?: unknown;
        statusCode?: number;
        response?: { statusCode?: number };
    };
    if (typeof e.code === "number") return e.code;
    return e.statusCode ?? e.response?.statusCode;
}

/**
 * The bound on the appended cause line — the same 200 characters the profile
 * ledger keeps (`tasks/data-profile.ts`), because a description reaches that
 * ledger and the run row. A stack trace and an engine response body must stay
 * out of a row, so the line is cut and marked rather than carried whole.
 */
const CAUSE_LINE_MAX = 200;

/**
 * The one bounded line that names the reason of a cause, or `undefined` when
 * the cause carries no reason to name.
 *
 * A `ZodError` is special-cased: its `message` is multi-line JSON whose first
 * line is `[`, which names nothing. Thus a zod cause renders as its first
 * issue — the path and the message — and the reader sees which field broke.
 * Any other cause gives the first line of its message.
 */
function causeLine(cause: unknown): string | undefined {
    let text: string;
    if (cause instanceof ZodError) {
        const issue = cause.issues[0];
        if (!issue) return undefined;
        const path = issue.path.join(".");
        text = path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    } else if (cause instanceof Error) {
        text = cause.message;
    } else if (typeof cause === "string") {
        text = cause;
    } else {
        return undefined;
    }
    const first = text.split("\n", 1)[0]!.trim();
    if (first.length === 0) return undefined;
    return first.length > CAUSE_LINE_MAX ? `${first.slice(0, CAUSE_LINE_MAX - 1)}…` : first;
}

/**
 * A one-line, user-facing description of a `SandboxError` for logs/error
 * bodies. The variant gives the head. Where the cause names a reason, that
 * bounded line closes the description, thus the engine or the parser says why
 * on the operator surfaces.
 */
export function describeSandboxError(e: SandboxError): string {
    // `farm_unavailable` is the one variant whose head already carries its
    // reason, the text of the resolver. A cause line after it would put two
    // dashes on one row, and the throw of a resolver is in the log with its
    // stack. Every other variant names its reason only through the cause.
    const line = e.type === "farm_unavailable" ? undefined : causeLine(e.cause);
    const head = describeVariant(e);
    return line === undefined ? head : `${head} — ${line}`;
}

/** The head of a description: what failed, at which op, on which subject. */
function describeVariant(e: SandboxError): string {
    switch (e.type) {
        case "container_create_failed":
            return `sandbox create failed (${e.op}${e.sandboxId ? `: ${e.sandboxId}` : ""})`;
        case "name_conflict":
            return `sandbox name collision (${e.op}: ${e.sandboxId} owned by ${e.owner ?? "<unlabeled>"})`;
        case "not_found":
            return `sandbox not found (${e.op}${e.sandboxId ? `: ${e.sandboxId}` : ""})`;
        case "submit_failed":
            return `sandbox exec submit failed (${e.op}: execId=${e.execId})`;
        case "teardown_failed":
            return `sandbox teardown failed (${e.op}${e.sandboxId ? `: ${e.sandboxId}` : ""})`;
        case "liveness_failed":
            return `sandbox liveness probe failed (${e.op}${e.sandboxId ? `: ${e.sandboxId}` : ""})`;
        case "farm_unavailable":
            return `farm unavailable (${e.op}: ${e.analysisId}) — ${e.reason}`;
        case "farm_unusable":
            return `farm unusable (${e.op}: ${e.analysisId}) — no usable inflexa.lock at ${e.lockPath} (${e.lockError})`;
    }
}

/**
 * The throw of the `SandboxClient` seam. The message is
 * `describeSandboxError`, thus a surface that renders a message alone still
 * names the fault and its reason. The variant rides two ways: on `cause`, so
 * a cause-chain reader keeps working, and on `error`, so a consumer that
 * matches the class reads the typed fields without a walk.
 */
export class SandboxFailure extends Error {
    constructor(readonly error: SandboxError) {
        super(describeSandboxError(error), { cause: error });
        this.name = "SandboxFailure";
    }
}

/**
 * Wrap a single sandbox backend call (Docker SDK op, K8s API op, or the
 * `/exec` POST). A throw becomes `err(toError(status, cause))`; the caller
 * supplies `toError` so each op classifies its own throw (create vs submit vs
 * teardown vs liveness) and special-cases 404/409.
 *
 * `fn` runs the single SDK/HTTP call and returns the already-mapped value
 * (`T`). Keep `fn` to that one call plus trivial mapping; do NOT embed
 * control-flow that could throw a non-backend error (the recv loop's
 * `HardCancelError`/`ExecTimeoutError` and DBOS cancellation must stay outside
 * any `trySandbox` so they propagate as control-flow, never become an `err`).
 */
export function trySandbox<T>(fn: () => Promise<T>, toError: (status: number | undefined, cause: unknown) => SandboxError): ResultAsync<T, SandboxError> {
    return new ResultAsync(
        (async () => {
            try {
                return ok(await fn());
            } catch (cause) {
                return err(toError(sandboxStatusOf(cause), cause));
            }
        })(),
    );
}

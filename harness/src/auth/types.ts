/**
 * Request identity — typed value objects and the two lifetime-typed bundles.
 *
 * Per-request identity is decomposed into small immutable value objects
 * (`Identity`, `Scope`, `Credential`, `Provenance`, `RunFrame`) plus an opaque
 * `auth` capability (`AuthContext`), instead of the old flat `Session`
 * grab-bag. The `auth` capability is the sole carrier of credential/org behind
 * a session — there is no top-level `orgId` or `credential` field. Optional
 * concerns are whole present-or-absent sub-objects: a `RunFrame` exists or it
 * doesn't; a `Credential` is an opaque bearer capability — never a nullable
 * field. Its concrete shape is a managed refinement; the harness never inspects it.
 *
 * Two bundles compose those objects with honest lifetimes:
 *   - `RequestSession` — the live HTTP door. No RunFrame; never JSON-serialized
 *     into durable state.
 *   - `RunSession` — durable, JSON-serializable. Carries a `RunFrame`; minted
 *     only at the run-authorization seam.
 *
 * Neither bundle carries resolved billing headers — billing is resolved
 * lazily at the LLM call site (see `harness/billing/resolver.ts`).
 */

/** Who the request is. Always complete. */
export interface Identity {
    readonly user: string;
}

/**
 * What the request operates on — a discriminated union owning its resource
 * coordinates (`scopeResource`) and the workload id (`scopeWorkloadId`) used
 * for attribution. `threadId` lives on the analysis variant only.
 */
export type Scope =
    | {
          readonly kind: "analysis";
          readonly analysisId: string;
          readonly threadId?: string;
      }
    | {
          readonly kind: "target-assessment";
          readonly targetAssessmentId: string;
          readonly billingContextId: string;
      };

declare const CRED_BRAND: unique symbol;

/**
 * Opaque bearer credential. The harness forwards it through the loop, providers, and
 * tools but NEVER inspects it — it has no readable fields. Only managed seam
 * adapters downcast it to their concrete realization, at a single contained
 * cast per reader. The optional phantom brand keeps the harness from reading any field
 * off it while still letting a concrete managed credential satisfy it
 * structurally.
 */
export interface Credential {
    readonly [CRED_BRAND]?: never;
}

/**
 * The agent call chain at the point of a call. Read-only provenance —
 * events, logs, and OTel spans read it; control flow MUST NOT branch on it.
 */
export interface Provenance {
    readonly agentId: string;
    readonly callPath: readonly string[];
}

/** Present only inside a workflow run. */
export interface RunFrame {
    readonly runId: string;
    readonly stepId?: string;
}

// ── Scope coordinate derivation ─────────────────────────────────────

/** Canonical resource coordinates a `Scope` resolves to. */
export interface ResourceCoordinates {
    readonly resourceType: "analysis" | "billing_context";
    readonly resourceId: string;
}

/**
 * Derive the `{ resourceType, resourceId }` a scope resolves through.
 * Analysis → `{ "analysis", analysisId }`; target-assessment →
 * `{ "billing_context", billingContextId }` (TA resolves billing via the
 * billing-context discriminator until it is a first-class resource).
 */
export function scopeResource(scope: Scope): ResourceCoordinates {
    return scope.kind === "analysis"
        ? { resourceType: "analysis", resourceId: scope.analysisId }
        : { resourceType: "billing_context", resourceId: scope.billingContextId };
}

/** The value stamped into the workload tag — the workload id for this scope. */
export function scopeWorkloadId(scope: Scope): string {
    return scope.kind === "analysis" ? scope.analysisId : scope.targetAssessmentId;
}

// ── Opaque inward auth capability ───────────────────────────────────

declare const AUTH_BRAND: unique symbol;

/**
 * The opaque inward auth capability carried by every session. The harness forwards it
 * through the loop, providers, and tools but NEVER inspects it — it has no
 * readable fields. Only managed seam adapters downcast it to their concrete
 * realization (`ManagedAuthContext = { credential, orgId }` in
 * `auth-context.ts`), at a single contained cast per adapter. OSS supplies a
 * trivial value. The optional phantom brand keeps the harness from reading any field
 * off it while still letting a managed `{ credential, orgId }` literal satisfy
 * it structurally.
 */
export interface AuthContext {
    readonly [AUTH_BRAND]?: never;
}

// ── Session bundles ─────────────────────────────────────────────────

/**
 * The session view the agent loop, the provider seam, and tools accept —
 * the union of what every layer below the HTTP door actually reads. The
 * session is a conduit: `runAgent` forwards it to the provider and into each
 * tool; tools forward it to `embed` and into nested `runAgent`s. The deepest
 * consumer is the provider, which reads every field, so the conduit type is
 * "all fields, generalized to what's read" — `credential` widened to the
 * opaque `Credential` (nothing in the harness branches on the concrete shape),
 * `runFrame` optional (only the billing assembler reads it).
 *
 * Both bundles satisfy this: a `RequestSession` (no RunFrame) and a
 * `RunSession` (with RunFrame) are each structurally assignable, so the
 * same agent loop runs under a live request and inside a durable workflow.
 */
export interface AgentSession {
    readonly identity: Identity;
    readonly scope: Scope;
    readonly provenance: Provenance;
    readonly runFrame?: RunFrame;
    /**
     * Opaque inward auth capability — the ONLY auth the harness conduit carries.
     * The harness forwards it but never inspects it; managed adapters downcast it via
     * `getAuth`. The sole source of credential/org behind a session.
     */
    readonly auth: AuthContext;
}

/**
 * The live HTTP door. No `RunFrame` — `runId`/`stepId` are unrepresentable
 * until async work is authorized. SHALL NOT be JSON-serialized into durable
 * state.
 */
export interface RequestSession {
    readonly identity: Identity;
    readonly scope: Scope;
    readonly provenance: Provenance;
    readonly auth: AuthContext;
}

/**
 * The durable, JSON-serializable bundle. Carries a `RunFrame`. Constructed
 * solely at the run-authorization seam.
 */
export interface RunSession {
    readonly identity: Identity;
    readonly scope: Scope;
    readonly provenance: Provenance;
    readonly runFrame: RunFrame;
    readonly auth: AuthContext;
}

/**
 * The minimal session view the billing-header assembler reads. Both bundles
 * satisfy it; `runFrame` is present only on a `RunSession`, so a
 * `RequestSession` emits no run/step tags.
 */
export interface BillingSessionView {
    readonly identity: Identity;
    readonly scope: Scope;
    readonly provenance: Provenance;
    readonly runFrame?: RunFrame;
}

/**
 * Derive a child session for a sub-agent call — provenance only. Sets the
 * child `agentId` and appends it to `callPath`, leaving identity, scope, and
 * auth untouched. Works on either bundle (the input type is preserved).
 */
export function forSubAgent<S extends { readonly provenance: Provenance }>(session: S, agentId: string): S {
    return {
        ...session,
        provenance: {
            agentId,
            callPath: [...session.provenance.callPath, agentId],
        },
    };
}

/**
 * Derive a child `RunSession` for a sandbox step — pure value derivation.
 * Sets `runFrame.stepId`; identity, scope, auth, and provenance are
 * unchanged. Used by parents when computing child workflow input.
 */
export function forStep(parent: RunSession, stepId: string): RunSession {
    return {
        ...parent,
        runFrame: { runId: parent.runFrame.runId, stepId },
    };
}

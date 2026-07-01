/**
 * Billing attribution seam.
 *
 * Defines the `ResolveBilling` contract the provider calls at the
 * LLM/embedding call site, plus the session view and fetcher types a
 * concrete resolver implements. The provider calls `resolveBilling(session)`
 * just before the wire call; read-only routes never call it, so they never
 * incur a billing round-trip.
 *
 * This module is the vendor-neutral seam: it declares types only. A concrete
 * resolver (managed/upstream-backed or noop) supplies the fetch + assembly
 * behavior behind the `ResolveBilling` function type.
 */

import type { AuthContext, BillingSessionView, Credential, ResourceCoordinates } from "../auth/types.js";

export type BillingMap = Record<string, string>;

/** Final wire-format header map sent to the upstream gateway. */
export type BillingHeaders = Record<string, string>;

/**
 * Result of a single billing-attribution fetch. The seam's own type — a
 * concrete resolver's richer result (e.g. a generic upstream envelope)
 * structurally satisfies it. The failure branch carries what the resolver
 * needs to raise a `BillingResolutionError`.
 */
export type BillingFetchResult = { ok: true; data: BillingMap } | { ok: false; status: number; error: { error: string; message: string } };

/**
 * The minimal session view a resolver reads. The cached map is keyed by
 * `(user, resourceType, resourceId)` (from `identity`/`scope` on
 * `BillingSessionView`); header assembly additionally consumes
 * `provenance`/`runFrame` (per-call). The fetch resolves the credential
 * + org via `getAuth(session)`, so only the opaque `auth` is needed here —
 * `AgentSession` structurally satisfies it.
 */
export interface ResolvableSession extends BillingSessionView {
    readonly auth: AuthContext;
}

/**
 * Resolve the FINAL wire headers at the call site. The raw attribution map is
 * fetched once per `(user, resource)` and cached; the per-call identity tags
 * (`agentId`/`runId`/`stepId`) vary within that key, so header assembly runs
 * POST-CACHE on every call against the live `session` — assembled headers are
 * never cached.
 */
export type ResolveBilling = (session: ResolvableSession) => Promise<BillingHeaders>;

/**
 * The upstream call seam — overridable in tests with a fake. A concrete
 * resolver resolves the attribution map for the given credential/org/coords.
 */
export type BillingFetcher = (credential: Credential, orgId: string, coords: ResourceCoordinates) => Promise<BillingFetchResult>;

/** A billing-resolution failure (e.g. 403/404). Fails the LLM call. */
export class BillingResolutionError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(`Billing resolution failed (${status} ${code}): ${message}`);
        this.name = "BillingResolutionError";
    }
}

/**
 * The provenance domain model: the kinds of tracked actions and the agent responsible for one.
 * These outlive any single storage choice — an analysis's provenance is a PROV document
 * (serialized as PROV-JSON onto `analyses.provenance`), built incrementally by the recorder in
 * `modules/prov/prov.ts` from the typed `prov.*` bus events that carry these shapes.
 */

/**
 * Who is responsible for an action. `user` is a logged-in person (their email), `anonymous` an
 * unauthenticated person, `system` the inflexa CLI itself acting autonomously (carries its version).
 */
export type ProvActorKind = "user" | "anonymous" | "system";

/**
 * The resolved responsible agent for an action — a discriminated union so the call site states
 * *which* kind it is recording, and so the document builder reads the right fields per kind.
 */
export type ProvActor =
    | { kind: "user"; email: string }
    | { kind: "anonymous" }
    | {
          kind: "system";
          /** The CLI's package version. */
          version: string;
          /** The exact source commit — baked at build time, resolved from git in dev. */
          commit: string;
      };

/**
 * The subset of an analysis input that provenance records: the identity fields for the PROV
 * entity (stable QName from anchor+path) and the attributes written onto it. The owning
 * `analysisId` is not needed — the analysis subject is already in the document.
 */
export type ProvInputRef = {
    path: string;
    isDir: boolean;
    anchorId: string | null;
};

/**
 * The outcome of `inflexa prov verify`: one of five mutually exclusive states, each with enough
 * detail for the CLI/TUI to render a clear message.
 */
export type VerifyResult = { status: "valid" } | { status: "unsigned" } | { status: "tampered"; detail: string } | { status: "no-key" } | { status: "empty" };

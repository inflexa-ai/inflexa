/**
 * The data profile's durable-frame identity, on the Cortex wire vocabulary.
 *
 * This lives in `contracts/` — not beside the workflow that stamps it — for the same reason every
 * other name here does: it is a value a CONSUMER reads back, and `contracts/` is the one part of the
 * package a consumer can import without inheriting the harness's own dependencies. The workflow
 * module that uses it pulls in DBOS, the sandbox client, and the profiler agent graph; a host that
 * imported the literal from there would pay ~120ms of module loading to obtain a string, on every
 * command that touches its ledger.
 *
 * That is not a packaging detail to be worked around at the call site. A constant whose whole purpose
 * is to be compared against stored data belongs where the data's vocabulary is declared.
 */

/**
 * The `runId` the harness stamps on every LLM call the data profile makes.
 *
 * A literal, not a minted id: the profile has no run row in any ledger, so this is the only thing
 * identifying its work as the profile's. A consumer needs it to READ BACK what the harness recorded —
 * usage accounting carries one run-id column, so a host reporting consumption "by run" finds profile
 * calls sitting among real runs and can separate them only by comparing against this value.
 *
 * Exported rather than merely documented so that comparison is a compile-time coupling. A host
 * holding its own copy of the string would keep compiling through a rename here, and quietly resume
 * reporting the profile as an unnamed run — a failure with no red test anywhere.
 */
export const DATA_PROFILE_RUN_LITERAL = "data-profile" as const;

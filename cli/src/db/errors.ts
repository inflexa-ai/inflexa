/** Which SQLite constraint a write tripped. Lets callers branch on the cause (e.g. a duplicate id) instead of treating every write failure alike. */
export type ConstraintKind = "unique" | "foreign_key" | "not_null" | "check";

/**
 * A storage-layer failure. Absence is deliberately NOT modelled here: single-row reads
 * return `T | null` and mutations against a missing row return `0` rows changed, so
 * "not found" rides the ok channel — `DbError` is reserved for genuine failures
 * (connection, exec, constraint, migration).
 */
export type DbError =
    | { type: "connection_failed"; cause: unknown }
    | { type: "query_failed"; op: string; cause: unknown }
    | { type: "mutation_failed"; op: string; cause: unknown }
    | { type: "constraint_violation"; constraint: ConstraintKind; op: string; cause: unknown }
    | { type: "migration_failed"; cause: unknown };

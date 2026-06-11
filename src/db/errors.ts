export type DbError =
    | { type: "connection_failed"; cause: unknown }
    | { type: "query_failed"; op: string; cause: unknown }
    | { type: "mutation_failed"; op: string; cause: unknown }
    | { type: "migration_failed"; cause: unknown };

import type { Connectable } from "@inflexa-ai/harness/lib/db-result.js";
import type { Querier } from "@inflexa-ai/harness/state/db.js";

/** One query that the code under test sent to a {@link fakePool}. */
export type FakeQuery = { readonly text: string; readonly values: readonly unknown[] };

/**
 * A {@link Querier} that answers each query with the rows that `answer` gives, for a test of code that reads
 * rows from Postgres. A rejection of `answer` is a rejected query. No cli test reaches Postgres, thus the test
 * matches the SQL text and gives the rows that the code under test expects for it.
 */
export function fakePool(answer: (query: FakeQuery) => readonly unknown[] | Promise<readonly unknown[]>): Querier {
    return {
        query: async (config, values) => {
            const query: FakeQuery =
                typeof config === "string" ? { text: config, values: values ?? [] } : { text: config.text, values: config.values ?? values ?? [] };
            const rows = await answer(query);
            // SAFETY: `Querier.query` is generic over the row shape that the caller names, and no type links that shape to the
            // SQL text. The test gives the rows that the code under test expects for the SQL that it matched, and `never[]`
            // fits each row shape that the caller names.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the row shape is caller-bound and cannot be derived from the SQL text (see SAFETY)
            return { rows: rows as never[], rowCount: rows.length };
        },
    };
}

/** A {@link fakePool} that also lends a client for a transaction. The client answers each query with the same `answer`. */
export function fakeTransactionalPool(answer: (query: FakeQuery) => readonly unknown[] | Promise<readonly unknown[]>): Querier & Connectable {
    const pool = fakePool(answer);
    return { ...pool, connect: () => Promise.resolve({ ...pool, release: () => {} }) };
}

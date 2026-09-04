import { Database } from "bun:sqlite";
import { Result, ok, err } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Migration } from "./util.ts";

export const migrations: Migration[] = [
    {
        // Single baseline. Tables are declared parent-before-child so every FK is a backward
        // reference. Columns follow the house order: the identity triple (id, created_at,
        // updated_at) first and colocated, then core data, then foreign keys last.
        version: 1,
        up: `
            CREATE TABLE anchors (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                cached_path TEXT NOT NULL,
                marker_written INTEGER NOT NULL,
                last_seen INTEGER NOT NULL
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                tags TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE analyses (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                name TEXT NOT NULL,
                slug TEXT NOT NULL,
                provenance TEXT,
                provenance_chain_hash TEXT,
                provenance_signature TEXT,
                provenance_prev_chain_hash TEXT,
                anchor_id TEXT NOT NULL REFERENCES anchors(id),
                project_id TEXT REFERENCES projects(id),
                -- The whole workspace (staged inputs, run artifacts, provenance exports) lives at
                -- …/analyses/<slug>/ under the anchor, so a slug must be unique within its anchor.
                -- This uniqueness is also what makes the harness workspace-root resolver injective.
                UNIQUE (anchor_id, slug)
            );
            CREATE INDEX idx_analyses_project ON analyses(project_id);
            CREATE INDEX idx_analyses_anchor ON analyses(anchor_id);
            -- Inputs are stored as references, never copies: the local filesystem is authoritative.
            -- Each row's path is relative-to-anchor when anchor_id is set (so it rides the anchor's
            -- UUID across moves/renames) and absolute otherwise. The analysis FK cascades — dropping
            -- an analysis takes its input refs with it. No identity triple: a ref is not an entity.
            -- anchor_id is nullable (raw absolute paths have no anchor), and SQLite treats each NULL
            -- as distinct in UNIQUE constraints — so a partial index pair covers both cases.
            CREATE TABLE analysis_inputs (
                path TEXT NOT NULL,
                is_dir INTEGER NOT NULL DEFAULT 0,
                analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
                anchor_id TEXT REFERENCES anchors(id)
            );
            CREATE INDEX idx_analysis_inputs_analysis ON analysis_inputs(analysis_id);
            CREATE UNIQUE INDEX uq_analysis_inputs_anchored
                ON analysis_inputs(analysis_id, path, anchor_id)
                WHERE anchor_id IS NOT NULL;
            CREATE UNIQUE INDEX uq_analysis_inputs_unanchored
                ON analysis_inputs(analysis_id, path)
                WHERE anchor_id IS NULL;
            -- Chat tables: the row is the opaque JSON \`data\` blob; the only columns are the id and
            -- the FK indexes. A session links to its analysis (one analysis, many sessions) via the
            -- analysis_id column, not the blob. Deleting an analysis cascades to its sessions,
            -- which cascades to messages, which cascades to parts.
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                analysis_id TEXT REFERENCES analyses(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_sessions_analysis ON sessions(analysis_id);
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                session_id TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_messages_session ON messages(session_id);
            CREATE TABLE parts (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_parts_message ON parts(message_id);
            CREATE INDEX idx_parts_session ON parts(session_id);
        `,
    },
    {
        // A conversation is single-homed in the harness Postgres thread store: it owns the session's
        // identity, its title, its activity timestamps, and every message. These three SQLite tables
        // were the second home — frozen with no writer and no reader — so the drop retires them rather
        // than leave dead schema inviting a new reader and reopening "which store is authoritative".
        //
        // What the drop achieves, stated exactly: the transcript rows become permanently unreachable
        // and their pages return to the freelist for reuse. The bytes are NOT scrubbed, and reclaiming
        // them is deliberately not attempted here — VACUUM cannot run inside the transaction this
        // migration executes in, and it transiently needs roughly the database's size again in free
        // space, a cost no upgrade should impose on a user's disk.
        //
        // IF EXISTS on all three: the database is a file the user owns and may hand-edit or restore, so
        // a table they already removed must not hard-fail the migration on every launch and brick every
        // command over data that is otherwise intact (CLAUDE.md → local state can desync).
        //
        // Dropped child-first (parts → messages → sessions), though nothing forces that order today:
        // every foreign key on this set is ON DELETE CASCADE, so parent-first succeeds just as well.
        // The child-first order is kept so the step stays correct if a future key ever declines to
        // cascade. Each table's indexes go with it, so they need no statements of their own.
        version: 2,
        up: `
            DROP TABLE IF EXISTS parts;
            DROP TABLE IF EXISTS messages;
            DROP TABLE IF EXISTS sessions;
        `,
    },
    {
        // The local LLM-usage ledger: one row per completed LLM call the harness reports through its
        // UsageRecorder seam. `record_key` IS the identity — the harness guarantees that key is stable
        // across every replay of the same call, so minting a synthetic id beside it would create two
        // things that must agree about what "the same call" is. Writes upsert on it; a usage row is an
        // observation, not an entity, so it carries no id/created_at/updated_at triple (the same
        // exception analysis_inputs takes). Column order still follows the house rule: identity
        // (record_key + its arrival stamp) first, then core data — there is no foreign-key group here.
        //
        // NO foreign key on any column, deliberately. `scope_id` is minted harness-side and includes
        // synthetic workload ids this database will never hold (the embedding boot probe and the
        // embedding setup verifier both drive agent loops under invented analysis ids). The recorder is
        // contractually forbidden to throw, so a referential constraint would fire on exactly the rows
        // it must never fail on. `thread_id`/`run_id`/`step_id` are attribution too, not relations.
        //
        // The scope rides as a discriminant + id rather than a single analysis_id so both variants of
        // the harness's Scope union are representable and neither is silently discarded; a per-analysis
        // read simply constrains scope_kind = 'analysis'.
        //
        // Every token column is nullable with NO NOT NULL and NO DEFAULT. Absent must stay
        // distinguishable from zero: 'NOT NULL DEFAULT 0' would rewrite "this provider does not report
        // cache reads" into "this provider reported zero cache reads", an unknown dressed as a
        // measurement. Reads aggregate with SUM(), which skips NULLs and itself yields NULL for a group
        // in which nothing was reported, so the distinction survives aggregation as well. The five are
        // named for the harness ChatUsage fields they carry, one column per field.
        //
        // Exactly one index, on (scope_kind, scope_id): every surface filters the scope first and the
        // model/agent breakdowns group underneath that filter. No run_id or served_model_id index —
        // nothing queries by either without a scope, and an index whose only justification is a query
        // no surface makes is write cost with no reader.
        version: 3,
        up: `
            CREATE TABLE llm_usage (
                record_key TEXT PRIMARY KEY,
                recorded_at INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                call_path TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                scope_id TEXT NOT NULL,
                thread_id TEXT,
                run_id TEXT,
                step_id TEXT,
                requested_model_id TEXT,
                served_model_id TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_creation_input_tokens INTEGER,
                cache_read_input_tokens INTEGER,
                reasoning_tokens INTEGER
            );
            CREATE INDEX idx_llm_usage_scope ON llm_usage(scope_kind, scope_id);
        `,
    },
    {
        // The detached transfer lifecycle of the package store: the runtime image, the
        // provisioner image, and the catalog. One row per kind, and the KIND is the id —
        // one transfer of a kind runs at a time, and "the transfer of that kind" is the
        // whole identity of the row, so a minted id beside it would make two things that
        // must agree about which row is current (the argument `llm_usage` makes for
        // `record_key`).
        //
        // `state` names the whole lifecycle. `declined` records a setup answer of no,
        // which starts no child; `canceled` records a transfer the user stopped. The
        // difference is load-bearing: only the second has a partial tree to drop.
        //
        // The byte and layer totals are nullable, and absent stays distinguishable from
        // zero: an image pull through the engine reports no byte total, and a catalog
        // transfer reports exact ones the moment its manifest resolves. `digest` records
        // what the last resolve saw (a manifest digest for the catalog, an image digest
        // for an image), which is how a reader learns of an update without the network.
        //
        // `holder_pid` names the child while one runs. Liveness does NOT come from this
        // column: the child holds an instance lock for its whole life, and a `running`
        // row with no live lock holder reads as `failed` (see modules/libs/transfers.ts).
        version: 4,
        up: `
            CREATE TABLE transfers (
                id TEXT PRIMARY KEY CHECK (id IN ('runtime_image', 'provisioner_image', 'catalog')),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'installed', 'failed', 'declined', 'canceled')),
                bytes_transferred INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER,
                layers_completed INTEGER NOT NULL DEFAULT 0,
                total_layers INTEGER,
                digest TEXT,
                message TEXT,
                holder_pid INTEGER
            );
        `,
    },
    {
        // The acquisition flights of `inflexa store add`: one row for each live flight.
        // A flight is the work of acquiring ONE normalized spec into the pool, and a
        // second request for that spec subscribes to the flight rather than starting a
        // second provisioner run.
        //
        // `id` IS the flight key — the ecosystem, the PEP 503 canonical name, and the
        // specifier, joined. The key is the whole identity of the flight, and a
        // single-column key lets the subscription table carry one foreign key. The three
        // parts ride their own columns as well, because a reader renders the spec.
        //
        // ONLY the two live states are permitted. A finished flight is not a cache: the
        // owner REMOVES the row when the flight ends, thus a failed acquisition leaves
        // nothing that would dedup the next request for the same spec. The CHECK is what
        // makes the reader's cast of the column sound.
        //
        // `holder_pid` is NOT NULL, because a row exists only while a process owns the
        // flight. That pid is the liveness signal: a row whose holder is dead is debris
        // from a killed process, and the next request sweeps it. A flight key is minted
        // at runtime, thus a lock file for each key would carry no more truth than this
        // column.
        //
        // A subscription is a reference row, not an entity, thus it carries no identity
        // triple — the same exception `analysis_inputs` takes. `analysis_id` is
        // nullable, because a plain `inflexa store add` in a terminal belongs to no
        // analysis and has no farm to extend. SQLite treats each NULL as distinct in a
        // UNIQUE constraint, so a partial index pair covers the two cases.
        version: 5,
        up: `
            CREATE TABLE package_store_flights (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('queued', 'running')),
                ecosystem TEXT CHECK (ecosystem IN ('python', 'r') OR ecosystem IS NULL),
                name TEXT NOT NULL,
                specifier TEXT NOT NULL,
                progress TEXT,
                holder_pid INTEGER NOT NULL
            );
            CREATE TABLE package_store_flight_subscriptions (
                flight_id TEXT NOT NULL REFERENCES package_store_flights(id) ON DELETE CASCADE,
                analysis_id TEXT REFERENCES analyses(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_ps_flight_subs_flight ON package_store_flight_subscriptions(flight_id);
            CREATE UNIQUE INDEX uq_ps_flight_subs_analysis
                ON package_store_flight_subscriptions(flight_id, analysis_id)
                WHERE analysis_id IS NOT NULL;
            CREATE UNIQUE INDEX uq_ps_flight_subs_host
                ON package_store_flight_subscriptions(flight_id)
                WHERE analysis_id IS NULL;
        `,
    },
    {
        // The pending set of `inflexa store add`. An approved add ENQUEUES here and
        // starts no provisioner run of its own: the flush takes the whole set into one
        // one-shot acquire run when the asks of the agent turn settle, or at once for a
        // direct terminal add. The set is host state in the database, because each
        // approved add runs as its own short-lived process (the run-inflexa subprocess)
        // and an in-memory set would not survive it.
        //
        // `ecosystem` is nullable: an unqualified name searches both ecosystems inside
        // the acquire run, and a name that both satisfy stops with the both-hit ask.
        //
        // `analysis_id` names the farm the add extends after the commit, and it clears
        // when the analysis leaves: the acquisition into the POOL stays worth keeping,
        // and only the farm work loses its target.
        version: 6,
        up: `
            CREATE TABLE pending_store_adds (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                name TEXT NOT NULL,
                specifier TEXT NOT NULL,
                ecosystem TEXT CHECK (ecosystem IN ('python', 'r') OR ecosystem IS NULL),
                analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL
            );
        `,
    },
    {
        // The terminal `failed` state of a flight, with its durable `message`. A
        // refusal of a DETACHED flush has no other surface: the child runs with
        // ignored stdio, thus the row is where the reason survives the process.
        // The message records the WHOLE error text — the surfaces bound the
        // render, and a truncation here would destroy the one durable copy.
        //
        // A CHECK constraint cannot change in place, thus the table rebuilds. The
        // subscriptions rebuild WITH it, child first on the drop side: a DROP of
        // the old parent under `PRAGMA foreign_keys = ON` runs an implicit
        // DELETE, and the old CASCADE would then eat the copied subscriptions.
        // The RENAME at the end rewrites the FK of the new child onto the final
        // table name.
        version: 7,
        up: `
            CREATE TABLE package_store_flights_v7 (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'failed')),
                ecosystem TEXT CHECK (ecosystem IN ('python', 'r') OR ecosystem IS NULL),
                name TEXT NOT NULL,
                specifier TEXT NOT NULL,
                progress TEXT,
                message TEXT,
                holder_pid INTEGER NOT NULL
            );
            INSERT INTO package_store_flights_v7
                SELECT id, created_at, updated_at, state, ecosystem, name, specifier, progress, NULL, holder_pid
                FROM package_store_flights;
            CREATE TABLE package_store_flight_subscriptions_v7 (
                flight_id TEXT NOT NULL REFERENCES package_store_flights_v7(id) ON DELETE CASCADE,
                analysis_id TEXT REFERENCES analyses(id) ON DELETE CASCADE
            );
            INSERT INTO package_store_flight_subscriptions_v7
                SELECT flight_id, analysis_id FROM package_store_flight_subscriptions;
            DROP TABLE package_store_flight_subscriptions;
            DROP TABLE package_store_flights;
            ALTER TABLE package_store_flights_v7 RENAME TO package_store_flights;
            ALTER TABLE package_store_flight_subscriptions_v7 RENAME TO package_store_flight_subscriptions;
            CREATE INDEX idx_ps_flight_subs_flight ON package_store_flight_subscriptions(flight_id);
            CREATE UNIQUE INDEX uq_ps_flight_subs_analysis
                ON package_store_flight_subscriptions(flight_id, analysis_id)
                WHERE analysis_id IS NOT NULL;
            CREATE UNIQUE INDEX uq_ps_flight_subs_host
                ON package_store_flight_subscriptions(flight_id)
                WHERE analysis_id IS NULL;
        `,
    },
    {
        // The phase of a transfer: which part of the work the child does right now. A
        // catalog transfer moves the bytes (`download`), and then it unpacks the layers
        // (`unpacking`). The two parts read the same on the byte counters — the last
        // byte lands before the unpacking starts — thus a surface cannot name the wait
        // from the counters alone.
        //
        // The column is NULLABLE with no default, and no backfill runs. An image
        // transfer declares no phase, and a row that a previous binary wrote knows none,
        // thus NULL is a normal value and every reader treats it as "no phase known". A
        // rollback drops nothing for the same reason.
        //
        // The CHECK names exactly the members of the union, the same as `state`, thus the
        // cast of the reader cannot widen. An additive ADD COLUMN appends the column at
        // the end of the table, and the phase belongs to the core-data group either way.
        version: 8,
        up: `
            ALTER TABLE transfers ADD COLUMN phase TEXT CHECK (phase IN ('download', 'unpacking') OR phase IS NULL);
        `,
    },
    {
        // The raw spelling of a store-add request, beside its canonical identity. The
        // `name` column is PEP 503 canonical, which keys the flight and the pool — but
        // an R installer needs the exact spelling (`GO.db`, not `go-db`), and a user
        // recognizes only the name that they typed. The identity cannot carry both
        // roles, thus the raw spelling gets its own column on the two request tables.
        //
        // The backfill copies `name`, because the canonical form is the only spelling
        // an old row still knows. The column stays NULLABLE and the readers fall back
        // to `name`, thus a rollback drops nothing and an unwritten row stays valid.
        version: 9,
        up: `
            ALTER TABLE pending_store_adds ADD COLUMN raw_name TEXT;
            UPDATE pending_store_adds SET raw_name = name;
            ALTER TABLE package_store_flights ADD COLUMN raw_name TEXT;
            UPDATE package_store_flights SET raw_name = name;
        `,
    },
    {
        // One spelling for each request. A request is a `PackageQuery` of the
        // harness `package-identity` capability, and a query holds ONE name: the
        // spelling that the caller wrote. The folded `name` column was the
        // identity of a Python distribution only, and on the R side it named
        // nothing that an installer can reach. Thus the two columns become one,
        // and the fold leaves the SQL.
        //
        // The backfill takes `raw_name`, which is the spelling that migration 9
        // recorded, and it falls back to `name` for a row that predates that
        // column. A live flight of `GO.db` keeps `GO.db`.
        //
        // The id of a flight IS its key, and the key now carries the spelling,
        // thus the rebuild mints it again from the backfilled columns. A kept id
        // would hold the fold: a later claim of `GO.db` computes `r::GO.db::`,
        // misses the `r::go-db::` row, and starts a second flight beside a
        // failed record that nothing ever clears. The recomputed key collides
        // with nothing, because two rows that share it shared the folded one too.
        // The subscriptions follow the same expression, because their foreign key
        // names the row that moved.
        //
        // A column cannot drop in place on the SQLite of this runtime, thus each
        // table rebuilds — the pattern of migration 7. The subscriptions rebuild
        // WITH the flights, child first on the drop side: a DROP of the old
        // parent under `PRAGMA foreign_keys = ON` runs an implicit DELETE, and
        // the old CASCADE would then eat the copied subscriptions. The RENAME at
        // the end rewrites the FK of the new child onto the final table name,
        // and the indexes come back with their own names, because a DROP TABLE
        // took the originals with it.
        version: 10,
        up: `
            CREATE TABLE pending_store_adds_v10 (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                spelling TEXT NOT NULL,
                specifier TEXT NOT NULL,
                ecosystem TEXT CHECK (ecosystem IN ('python', 'r') OR ecosystem IS NULL),
                analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL
            );
            INSERT INTO pending_store_adds_v10
                SELECT id, created_at, COALESCE(raw_name, name), specifier, ecosystem, analysis_id
                FROM pending_store_adds;
            DROP TABLE pending_store_adds;
            ALTER TABLE pending_store_adds_v10 RENAME TO pending_store_adds;
            CREATE TABLE package_store_flights_v10 (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'failed')),
                ecosystem TEXT CHECK (ecosystem IN ('python', 'r') OR ecosystem IS NULL),
                spelling TEXT NOT NULL,
                specifier TEXT NOT NULL,
                progress TEXT,
                message TEXT,
                holder_pid INTEGER NOT NULL
            );
            INSERT INTO package_store_flights_v10
                SELECT COALESCE(ecosystem, 'any') || '::' || COALESCE(raw_name, name) || '::' || specifier,
                       created_at, updated_at, state, ecosystem, COALESCE(raw_name, name), specifier, progress, message, holder_pid
                FROM package_store_flights;
            CREATE TABLE package_store_flight_subscriptions_v10 (
                flight_id TEXT NOT NULL REFERENCES package_store_flights_v10(id) ON DELETE CASCADE,
                analysis_id TEXT REFERENCES analyses(id) ON DELETE CASCADE
            );
            INSERT INTO package_store_flight_subscriptions_v10
                SELECT COALESCE(f.ecosystem, 'any') || '::' || COALESCE(f.raw_name, f.name) || '::' || f.specifier, s.analysis_id
                FROM package_store_flight_subscriptions s
                JOIN package_store_flights f ON f.id = s.flight_id;
            DROP TABLE package_store_flight_subscriptions;
            DROP TABLE package_store_flights;
            ALTER TABLE package_store_flights_v10 RENAME TO package_store_flights;
            ALTER TABLE package_store_flight_subscriptions_v10 RENAME TO package_store_flight_subscriptions;
            CREATE INDEX idx_ps_flight_subs_flight ON package_store_flight_subscriptions(flight_id);
            CREATE UNIQUE INDEX uq_ps_flight_subs_analysis
                ON package_store_flight_subscriptions(flight_id, analysis_id)
                WHERE analysis_id IS NOT NULL;
            CREATE UNIQUE INDEX uq_ps_flight_subs_host
                ON package_store_flight_subscriptions(flight_id)
                WHERE analysis_id IS NULL;
        `,
    },
];

export function runMigrations(db: Database, migrations: Migration[]): Result<void, DbError> {
    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )
        `);

        const applied = db.query("SELECT MAX(version) as v FROM _migrations").get() as { v: number | null };
        const currentVersion = applied.v ?? 0;

        for (const m of migrations) {
            if (m.version <= currentVersion) continue;
            db.transaction(() => {
                db.run(m.up);
                db.query("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
            })();
        }

        return ok(undefined);
    } catch (cause) {
        return err({ type: "migration_failed", cause });
    }
}

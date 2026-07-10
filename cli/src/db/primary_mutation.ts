import { randomUUIDv7 } from "bun";
import { sep } from "node:path";
import type { Result } from "neverthrow";
import { tryMutation, withTransaction } from "./util.ts";
import type { DbError } from "./errors.ts";
import type { Session, Message, Part, TextPart } from "../types/session.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Project } from "../types/project.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import type { Str256 } from "../lib/types.ts";

/**
 * Creates and persists a new chat session for an analysis, defaulting the title when omitted.
 * The analysis link lives in the `analysis_id` column (queried/joined by
 * `listSessionsByAnalysis`), not the Session JSON — so the Session type stays link-free.
 */
export function createSession(opts: { title?: string; analysisId: string }): Result<Session, DbError> {
    const session: Session = {
        id: randomUUIDv7(),
        title: opts.title ?? "New session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    return tryMutation("createSession", (conn) => {
        conn.query("INSERT INTO sessions (id, data, analysis_id) VALUES (?, ?, ?)").run(session.id, JSON.stringify(session), opts.analysisId);
        return session;
    });
}

/**
 * Mints and persists a new project. A duplicate `name` trips the `UNIQUE` constraint and
 * surfaces as `constraint_violation` (`unique`) for the caller to translate.
 */
export function createProject(input: { name: Str256; description: string | null; tags: string[] }): Result<Project, DbError> {
    const now = Date.now();
    const project: Project = {
        id: randomUUIDv7(),
        createdAt: now,
        updatedAt: now,
        name: input.name,
        description: input.description,
        tags: input.tags,
    };
    return tryMutation("createProject", (conn) => {
        conn.query("INSERT INTO projects (id, created_at, updated_at, name, description, tags) VALUES (?, ?, ?, ?, ?, ?)").run(
            project.id,
            project.createdAt,
            project.updatedAt,
            project.name,
            project.description,
            // tags hold no commas (comma-split on input), so a comma-join round-trips losslessly.
            project.tags.join(","),
        );
        return project;
    });
}

/** Persists `session`, stamping a fresh `updatedAt` (mutates the argument). Returns rows changed — `0` when no such session exists. */
export function updateSession(session: Session): Result<number, DbError> {
    session.updatedAt = Date.now();
    return tryMutation("updateSession", (conn) => {
        return conn.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), session.id).changes;
    });
}

/** Creates and persists an empty message turn for `role` in the session. */
export function createMessage(sessionId: string, role: "user" | "assistant"): Result<Message, DbError> {
    const msg: Message = {
        id: randomUUIDv7(),
        sessionId,
        role,
        createdAt: Date.now(),
    };

    return tryMutation("createMessage", (conn) => {
        conn.query("INSERT INTO messages (id, data, session_id) VALUES (?, ?, ?)").run(msg.id, JSON.stringify(msg), msg.sessionId);
        return msg;
    });
}

/** Persists `message`'s data blob (e.g. the assistant turn's stamped `durationMs`). Returns rows changed — `0` when no such message exists. */
export function updateMessage(message: Message): Result<number, DbError> {
    return tryMutation("updateMessage", (conn) => {
        return conn.query("UPDATE messages SET data = ? WHERE id = ?").run(JSON.stringify(message), message.id).changes;
    });
}

/** Creates and persists a text part under a message — the unit the assistant streams into. */
export function createPart(sessionId: string, messageId: string, text: string): Result<TextPart, DbError> {
    const part: TextPart = {
        id: randomUUIDv7(),
        sessionId,
        messageId,
        type: "text",
        text,
        createdAt: Date.now(),
    };
    return tryMutation("createPart", (conn) => {
        conn.query("INSERT INTO parts (id, data, session_id, message_id) VALUES (?, ?, ?, ?)").run(
            part.id,
            JSON.stringify(part),
            part.sessionId,
            part.messageId,
        );
        return part;
    });
}

/** Persists a part's current text — called once the stream into it completes. Returns rows changed — `0` when no such part exists. */
export function updatePart(part: Part): Result<number, DbError> {
    return tryMutation("updatePart", (conn) => {
        return conn.query("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(part), part.id).changes;
    });
}

/**
 * Inserts a fully-formed anchor row. The caller supplies the id — rather than this
 * minting one like the session helpers — because an anchor's id is its write-once
 * marker id, which may already exist on disk and must be preserved, not regenerated.
 */
export function insertAnchor(anchor: Anchor): Result<Anchor, DbError> {
    return tryMutation("insertAnchor", (conn) => {
        conn.query("INSERT INTO anchors (id, created_at, updated_at, cached_path, marker_written, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run(
            anchor.id,
            anchor.createdAt,
            anchor.updatedAt,
            anchor.cachedPath,
            anchor.markerWritten ? 1 : 0,
            anchor.lastSeen,
        );
        return anchor;
    });
}

/** Re-points an anchor at `cachedPath`. A real data edit, so it bumps `updatedAt`; the `lastSeen` heartbeat stays separate. Returns rows changed — `0` when no such anchor exists. */
export function updateAnchorCachedPath(id: string, cachedPath: string): Result<number, DbError> {
    return tryMutation("updateAnchorCachedPath", (conn) => {
        return conn.query("UPDATE anchors SET cached_path = ?, updated_at = ? WHERE id = ?").run(cachedPath, Date.now(), id).changes;
    });
}

/** Records a sighting heartbeat (`lastSeen`) only — deliberately does NOT touch `updatedAt`, the data-edit timestamp. Returns rows changed — `0` when no such anchor exists. */
export function touchAnchor(id: string): Result<number, DbError> {
    return tryMutation("touchAnchor", (conn) => {
        return conn.query("UPDATE anchors SET last_seen = ? WHERE id = ?").run(Date.now(), id).changes;
    });
}

/** Drops an anchor row by its id. Returns rows changed — `0` when no such row exists. */
export function deleteAnchor(id: string): Result<number, DbError> {
    return tryMutation("deleteAnchor", (conn) => {
        return conn.query("DELETE FROM anchors WHERE id = ?").run(id).changes;
    });
}

// --- Data model: analyses ---

/** Inserts a fully-formed analysis row. The caller mints the id (`randomUUIDv7()`) and resolves the slug before calling. */
export function insertAnalysis(analysis: Analysis): Result<Analysis, DbError> {
    return tryMutation("insertAnalysis", (conn) => {
        conn.query("INSERT INTO analyses (id, created_at, updated_at, name, slug, anchor_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            analysis.id,
            analysis.createdAt,
            analysis.updatedAt,
            analysis.name,
            analysis.slug,
            analysis.anchorId,
            analysis.projectId,
        );
        return analysis;
    });
}

/** Attaches/moves/clears an analysis's project grouping in one targeted write (bumps `updated_at`). Returns rows changed — `0` when no such analysis exists. */
export function updateAnalysisProject(id: string, projectId: string | null): Result<number, DbError> {
    return tryMutation("updateAnalysisProject", (conn) => {
        return conn.query("UPDATE analyses SET project_id = ?, updated_at = ? WHERE id = ?").run(projectId, Date.now(), id).changes;
    });
}

/** Inserts a single input ref for an analysis. */
export function insertAnalysisInput(input: AnalysisInput): Result<AnalysisInput, DbError> {
    return tryMutation("insertAnalysisInput", (conn) => {
        conn.query("INSERT INTO analysis_inputs (path, is_dir, analysis_id, anchor_id) VALUES (?, ?, ?, ?)").run(
            input.path,
            input.isDir ? 1 : 0,
            input.analysisId,
            input.anchorId,
        );
        return input;
    });
}

/**
 * Removes a single input ref, matched by its identity (owning analysis + path + source anchor).
 * `anchor_id` is matched with `IS` so a `null` (raw path) ref compares equal. Returns rows
 * deleted — `0` when no such ref exists.
 */
export function deleteAnalysisInput(input: AnalysisInput): Result<number, DbError> {
    return tryMutation("deleteAnalysisInput", (conn) => {
        return conn.query("DELETE FROM analysis_inputs WHERE analysis_id = ? AND path = ? AND anchor_id IS ?").run(input.analysisId, input.path, input.anchorId)
            .changes;
    });
}

/** Deletes every analysis homed at an anchor (their input refs cascade via the analysis FK). Used by `prune` before dropping a dead anchor, since the analyses→anchors FK has no ON DELETE CASCADE. Returns rows deleted. */
export function deleteAnalysesForAnchor(anchorId: string): Result<number, DbError> {
    return tryMutation("deleteAnalysesForAnchor", (conn) => {
        return conn.query("DELETE FROM analyses WHERE anchor_id = ?").run(anchorId).changes;
    });
}

/** Deletes a single analysis by id. Its `analysis_inputs` and `sessions` cascade via FKs. Returns rows deleted from analyses — `0` when no such row exists. */
export function deleteAnalysis(id: string): Result<number, DbError> {
    return tryMutation("deleteAnalysis", (conn) => {
        return conn.query("DELETE FROM analyses WHERE id = ?").run(id).changes;
    });
}

/** Deletes a project by id. Analyses referencing it are NOT deleted — their `project_id` is NULLed so they become ungrouped. Returns rows deleted — `0` when no such row exists. */
export function deleteProject(id: string): Result<number, DbError> {
    return withTransaction("deleteProject", () =>
        tryMutation("deleteProject.unlink", (conn) => {
            conn.query("UPDATE analyses SET project_id = NULL, updated_at = ? WHERE project_id = ?").run(Date.now(), id);
        }).andThen(() =>
            tryMutation("deleteProject.delete", (conn) => {
                return conn.query("DELETE FROM projects WHERE id = ?").run(id).changes;
            }),
        ),
    );
}

/** Deletes a session and its messages/parts (which cascade via FKs). Returns rows deleted — `0` when no such row exists. */
export function deleteSession(id: string): Result<number, DbError> {
    return tryMutation("deleteSession", (conn) => {
        return conn.query("DELETE FROM sessions WHERE id = ?").run(id).changes;
    });
}

/** Renames a session by rewriting its JSON `data` blob's `title` field. Returns rows changed — `0` when no such session exists. */
export function renameSession(id: string, title: string): Result<number, DbError> {
    return tryMutation("renameSession", (conn) => {
        const row = conn.query("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null;
        if (!row) return 0;
        // Data written by our own JSON.stringify in createSession — parse failure means a corrupt
        // DB blob, which tryMutation surfaces as mutation_failed (an appropriate severity).
        const session = JSON.parse(row.data) as Session;
        session.title = title;
        session.updatedAt = Date.now();
        return conn.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), id).changes;
    });
}

/** Renames an analysis and regenerates its slug. The caller provides the new name + slug. Returns rows changed — `0` when no such analysis exists. */
export function renameAnalysis(id: string, name: Str256, slug: string): Result<number, DbError> {
    return tryMutation("renameAnalysis", (conn) => {
        return conn.query("UPDATE analyses SET name = ?, slug = ?, updated_at = ? WHERE id = ?").run(name, slug, Date.now(), id).changes;
    });
}

/** Updates a project's mutable fields (name, description, tags). Returns rows changed — `0` when no such project exists. */
export function updateProject(id: string, opts: { name: Str256; description: string | null; tags: string[] }): Result<number, DbError> {
    return tryMutation("updateProject", (conn) => {
        return conn
            .query("UPDATE projects SET name = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?")
            .run(opts.name, opts.description, opts.tags.join(","), Date.now(), id).changes;
    });
}

/**
 * Rewrites the path prefix of every raw (anchor-less) input under a moved tree
 * (`fromPrefix` → `toPrefix`). Anchor-relative inputs already ride their anchor's reconciled
 * location, so only `anchor_id IS NULL` rows need this. Returns how many paths were rewritten.
 */
export function relocateRawInputPrefix(fromPrefix: string, toPrefix: string): Result<number, DbError> {
    return tryMutation("relocateRawInputPrefix", (conn) => {
        const rows = conn.query("SELECT rowid, path FROM analysis_inputs WHERE anchor_id IS NULL AND path LIKE ?").all(`${fromPrefix}%`) as {
            rowid: number;
            path: string;
        }[];
        let rewritten = 0;
        for (const r of rows) {
            // `LIKE 'prefix%'` can match a sibling (`/a/bc` under `/a/b`); only rewrite a true
            // path-boundary match — the prefix exactly, or followed by a separator.
            if (r.path === fromPrefix || r.path.startsWith(fromPrefix + sep)) {
                conn.query("UPDATE analysis_inputs SET path = ? WHERE rowid = ?").run(toPrefix + r.path.slice(fromPrefix.length), r.rowid);
                rewritten++;
            }
        }
        return rewritten;
    });
}

// --- Data model: provenance ---

/**
 * Persists the PROV-JSON serialization of an analysis's provenance document and its integrity
 * columns. All three are required — unsigned provenance is never written (the signing key is
 * generated on first use, so absence is a hard fault, not a graceful-degradation case). The
 * UPDATE atomically rotates the chain: the current `provenance_chain_hash` becomes
 * `provenance_prev_chain_hash` before the new values land, so the verifier can always recompute
 * `chainHash = SHA-256(prevChainHash || provJson)` from stored data alone. Deliberately does NOT
 * bump `updated_at`: provenance is recorded metadata flushed asynchronously, not a user data-edit
 * — the same reasoning as `touchAnchor` leaving `updatedAt` alone. Returns rows changed.
 */
export function updateAnalysisProvenance(id: string, provenance: string, chainHash: string, signature: string): Result<number, DbError> {
    return tryMutation("updateAnalysisProvenance", (conn) => {
        return conn
            .query(
                `UPDATE analyses
                 SET provenance = ?,
                     provenance_prev_chain_hash = provenance_chain_hash,
                     provenance_chain_hash = ?,
                     provenance_signature = ?
                 WHERE id = ?`,
            )
            .run(provenance, chainHash, signature, id).changes;
    });
}

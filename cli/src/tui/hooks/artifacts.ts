import type { ArtifactError } from "../../api/artifacts.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientOpts } from "../../client/api.ts";
import { resolveArtifacts } from "../../client/artifacts.ts";
import { openExternal } from "../../lib/open_external.ts";
import type { OpenableEntry, OpenTarget } from "../../types/session.ts";
import { notify } from "./notice.ts";
import type { Notice } from "../theme.ts";

// The shared "open this artifact and toast the outcome" wiring, used by the three open affordances (a card
// click in `message_block.tsx`, the `o` binding in `app.tsx`, and the "Browse artifacts…" picker in
// `commands.tsx`). The server resolves the entry and writes its echart or svg file
// (`POST {A}/artifacts/resolve` with `materialize`), and this client opens the path, because the desktop
// opener runs on the machine of the user. A failed open ALWAYS degrades to a notice — never a crash, never
// a blocked turn — and carries the resolved path so the user can open it manually (the artifact-open
// spec's rule).

/** Map a resolution failure onto its user-facing notice, naming the resolved path/reason so manual opening stays possible. */
function noticeForError(e: ArtifactError): Notice {
    switch (e.type) {
        case "unresolved":
            return { kind: "warn", text: "Could not locate this analysis's workspace to open the artifact." };
        case "missing":
            return { kind: "warn", text: `File not found: ${e.path}` };
        case "materialize_failed":
            return { kind: "error", text: "Could not prepare the content for external viewing." };
        case "unavailable":
            return { kind: "warn", text: `Nothing to open: ${e.reason}` };
        default: {
            const _exhaustive: never = e;
            return _exhaustive;
        }
    }
}

/** Resolve `target` through the server, then open the path in the default OS application and toast the outcome. */
async function openTarget(analysisId: string, target: OpenTarget, opts: ClientOpts): Promise<void> {
    (await resolveArtifacts(analysisId, { entries: [target], materialize: true }, opts)).match(
        ({ entries: [entry] }) => {
            if (entry?.error !== undefined) return notify(noticeForError(entry.error));
            const path = entry?.path ?? null;
            if (path === null) return notify(noticeForError({ type: "unresolved" }));
            openExternal(path).match(
                () => notify({ kind: "info", text: `Opened ${path}` }),
                () => notify({ kind: "warn", text: `Could not launch an opener — open it manually: ${path}` }),
            );
        },
        (e) => notify({ kind: "warn", text: `Could not open the artifact: ${describeClientError(e)}` }),
    );
}

/** Open an openable card entry in the default OS application, toasting the resolved path or the failure. */
export function openArtifact(analysisId: string, entry: OpenableEntry, opts: ClientOpts = DEFAULT_CLIENT_OPTS): void {
    void openTarget(analysisId, entry.target, opts);
}

/**
 * Reveal a gallery's containing folder in the OS file browser, toasting the resolved path or the failure.
 * The folder goes to the server as a workspace file: its path resolves the same way, and its absence is
 * the same `missing`.
 */
export function openArtifactFolder(analysisId: string, folder: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): void {
    void openTarget(analysisId, { kind: "workspace-file", path: folder }, opts);
}

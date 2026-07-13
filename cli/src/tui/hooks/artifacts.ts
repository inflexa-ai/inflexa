import { openEntry, openFolder, type OpenArtifactError } from "../../modules/harness/artifact_open.ts";
import { notify } from "./notice.ts";
import type { Notice } from "../theme.ts";
import type { OpenableEntry } from "../../types/session.ts";

// The shared "open this artifact and toast the outcome" wiring, used by the three open affordances (a card
// click in `message_block.tsx`, the `o` binding in `app.tsx`, and the "Browse artifacts…" picker in
// `commands.tsx`). A failed open ALWAYS degrades to a notice — never a crash, never a blocked turn — and
// carries the resolved path so the user can open it manually (the artifact-open spec's rule).

/** Map an open failure onto its user-facing notice, naming the resolved path/reason so manual opening stays possible. */
function noticeForError(e: OpenArtifactError): Notice {
    switch (e.type) {
        case "unresolved":
            return { kind: "warn", text: "Could not locate this analysis's workspace to open the artifact." };
        case "missing":
            return { kind: "warn", text: `File not found: ${e.path}` };
        case "materialize_failed":
            return { kind: "error", text: "Could not prepare the content for external viewing." };
        case "open_failed":
            return { kind: "warn", text: `Could not launch an opener — open it manually: ${e.path}` };
        case "unavailable":
            return { kind: "warn", text: `Nothing to open: ${e.reason}` };
        default: {
            const _exhaustive: never = e;
            return _exhaustive;
        }
    }
}

/** Open an openable card entry in the default OS application, toasting the resolved path or the failure. */
export function openArtifact(analysisId: string, entry: OpenableEntry): void {
    openEntry(analysisId, entry.target).match(
        (path) => notify({ kind: "info", text: `Opened ${path}` }),
        (e) => notify(noticeForError(e)),
    );
}

/** Reveal a gallery's containing folder in the OS file browser, toasting the resolved path or the failure. */
export function openArtifactFolder(analysisId: string, folder: string): void {
    openFolder(analysisId, folder).match(
        (path) => notify({ kind: "info", text: `Opened ${path}` }),
        (e) => notify(noticeForError(e)),
    );
}

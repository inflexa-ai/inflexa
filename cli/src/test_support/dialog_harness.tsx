import { Show, type JSX } from "solid-js";

import { DialogOverlay } from "../tui/components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "../tui/contexts/workspace.ts";
import { useKeymapRoot } from "../tui/keymap.ts";

/**
 * The mount node of the dialog render tests: the production `DialogOverlay` inside a full-size box,
 * under a keymap root, with the workspace — when one is given — as a plain constant in
 * `WorkspaceContext`. Driving the REAL host is what makes the dialog under assertion the one
 * production mounts, not a hand-built stand-in that could drift from it.
 *
 * The workspace is closed over rather than passed as a prop so the Provider's value stays a plain
 * constant and never re-fires subscribers across a render.
 */
export function dialogHostNode(workspace?: Workspace): () => JSX.Element {
    return () => {
        useKeymapRoot();
        // The overlay is built inline, never hoisted to a variable: a solid component created before
        // its provider runs roots outside the provider's context, and the dialog content would then
        // read `WorkspaceContext` as empty.
        return (
            <Show
                when={workspace !== undefined}
                fallback={
                    <box width="100%" height="100%">
                        <DialogOverlay />
                    </box>
                }
            >
                <WorkspaceContext.Provider value={workspace}>
                    <box width="100%" height="100%">
                        <DialogOverlay />
                    </box>
                </WorkspaceContext.Provider>
            </Show>
        );
    };
}

import { createMemo } from "solid-js";
import type { JSX } from "solid-js";

import { GLYPHS } from "../../lib/glyphs.ts";
import { SelectList, type SelectItem } from "./select_list.tsx";
import { useWorkspace, type Workspace } from "../contexts/workspace.ts";
import type { Command } from "../commands.tsx";

// The palette UI layer: the single dispatch verb and the command palette itself. The searchable
// list engine and the generic dialog shells (`PromptDialog`, `ResultsDialog`) are reusable
// widgets in `components/`. Command *definitions* live in `commands.tsx`; this file only knows
// how to display and run them, so it imports `commands.tsx` for types ONLY — `App` injects the
// concrete `commands` array as a prop, keeping the runtime dependency one-directional
// (commands.tsx → command_palette.tsx).

/** Run a command with the in-app capability surface. The single funnel every entry point uses. */
export async function runCommand(cmd: Command, ws: Workspace): Promise<void> {
    await cmd.run(ws);
}

/** The command palette: a thin adapter mapping commands to {@link SelectList} rows + dispatch. */
export function CommandPalette(props: { commands: Command[] }): JSX.Element {
    const ws = useWorkspace();
    const items = createMemo<SelectItem<Command>[]>(() =>
        props.commands
            .filter((c) => c.enabled?.(ws) ?? true)
            .map((c) => ({ value: c, title: c.title, description: c.description, hint: c.keybind, category: c.category })),
    );
    return (
        <SelectList
            title="Commands"
            placeholder={`Search commands${GLYPHS.ellipsis}`}
            items={items()}
            emptyText="No matching commands"
            grouped
            onCancel={() => ws.closeDialog()}
            onSelect={(cmd) => {
                // Close the palette BEFORE running, so a command that opens its own dialog
                // replaces (not stacks on) the palette.
                ws.closeDialog();
                void runCommand(cmd, ws);
            }}
        />
    );
}

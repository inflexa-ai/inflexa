import { For, Show } from "solid-js";

import { GLYPHS } from "../../lib/glyphs.ts";
import { zIndex } from "../../lib/z_index.ts";
import { theme } from "../theme.ts";
import { leaderActive, pendingSequence, reachableKeys, sequenceLabel, type NextKey } from "../keymap.ts";

// The which-key overlay: while a leader sequence is half-typed, this panel lists every reachable
// next stroke with its description, grouped — the live "what can I press next" menu. It is FREE
// documentation: every label comes from the bindings' own `desc`/`group` (via `reachableKeys`), so
// there is no separate shortcut table to keep in sync. Part of the layout app-shell kit (a docked
// overlay above the chat), single-caller like `StatusBar` — which the kit explicitly allows.

/** Reachable next strokes bucketed by group, groups sorted alphabetically (continues-first within). */
function groups(keys: NextKey[]): [string, NextKey[]][] {
    const map = new Map<string, NextKey[]>();
    for (const nk of keys) map.set(nk.group, [...(map.get(nk.group) ?? []), nk]);
    for (const [, entries] of map) entries.sort((a, b) => Number(b.continues) - Number(a.continues) || a.desc.localeCompare(b.desc));
    return [...map].sort((a, b) => a[0].localeCompare(b[0]));
}

/** The which-key panel — auto-shown while a leader sequence is pending; hidden otherwise. */
export function WhichKey() {
    const keys = (): NextKey[] => reachableKeys();
    return (
        <Show when={leaderActive() && keys().length > 0}>
            <box
                position="absolute"
                bottom={1}
                left={2}
                zIndex={zIndex.popover}
                maxWidth={50}
                flexDirection="column"
                backgroundColor={theme().bgPanel}
                border
                borderColor={theme().accent}
                title={`${sequenceLabel(pendingSequence())}${GLYPHS.ellipsis}`}
                titleColor={theme().accent}
                paddingLeft={1}
                paddingRight={1}
            >
                <For each={groups(keys())}>
                    {([label, entries]) => (
                        <box flexDirection="column">
                            <text fg={theme().muted} attributes={1}>
                                {label}
                            </text>
                            <For each={entries}>
                                {(nk) => (
                                    <box flexDirection="row" paddingLeft={1}>
                                        <text fg={theme().warn}>{nk.stroke}</text>
                                        <text fg={theme().fg}>
                                            {"  "}
                                            {nk.desc}
                                            {nk.continues ? ` ${GLYPHS.ellipsis}` : ""}
                                        </text>
                                    </box>
                                )}
                            </For>
                        </box>
                    )}
                </For>
            </box>
        </Show>
    );
}

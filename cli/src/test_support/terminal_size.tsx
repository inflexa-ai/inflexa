import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";

import { TerminalSizeContext } from "../tui/contexts/terminal_size.ts";

/** The terminal size Provider that `App` mounts, for a test that renders a block without `App`. */
export function WithTerminalSize(props: { children: JSX.Element }): JSX.Element {
    return <TerminalSizeContext.Provider value={useTerminalDimensions()}>{props.children}</TerminalSizeContext.Provider>;
}

import { createContext, useContext } from "solid-js";
import type { Accessor } from "solid-js";

export type TerminalSize = { width: number; height: number };

/**
 * The terminal size of the one `useTerminalDimensions` subscription that `App` owns. The renderer is an
 * EventEmitter with the default limit of 10 listeners, and a component that renders once for each tool
 * call must not add a `resize` listener of its own. No default value: a missing Provider is a wiring bug.
 */
export const TerminalSizeContext = createContext<Accessor<TerminalSize>>();

/** Read the terminal size from context. Throws when called outside a `TerminalSizeContext.Provider`, as `useWorkspace` does. */
export function useTerminalSize(): Accessor<TerminalSize> {
    const size = useContext(TerminalSizeContext);
    if (!size) throw new Error("useTerminalSize must be called within a TerminalSizeContext.Provider");
    return size;
}

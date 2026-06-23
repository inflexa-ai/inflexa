import { testRender } from "@opentui/solid";

/**
 * Renders a component tree headlessly at a fixed terminal size and returns the captured text frame
 * with each line right-trimmed and trailing blank lines dropped. Always destroys the renderer — even
 * if capture throws — because a leaked renderer holds the native/terminal handles open and can
 * segfault Bun on a later render (CLAUDE.md → "Launch and exit").
 *
 * Sweep multiple sizes when asserting layout: opentui's yoga quirks (flexShrink, scrollbox overlap)
 * are size-dependent, so a single height hides them (CLAUDE.md → "Layout (flex)").
 *
 * The node type is taken from `testRender` itself (`() => JSX.Element`) so this file needs no JSX of
 * its own — callers in `.tsx` test files pass the component.
 */
export async function renderFrame(node: Parameters<typeof testRender>[0], size: { width: number; height: number }): Promise<string> {
    const setup = await testRender(node, size);
    try {
        await setup.renderOnce();
        return setup
            .captureCharFrame()
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n")
            .trimEnd();
    } finally {
        setup.renderer.destroy();
    }
}

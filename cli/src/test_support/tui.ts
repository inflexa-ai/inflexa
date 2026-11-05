import { testRender } from "@opentui/solid";
import type { RGBA } from "@opentui/core";

/** The render handle `testRender` gives back, with the frame, span, and input members tests drive. */
export type RenderSetup = Awaited<ReturnType<typeof testRender>>;

/**
 * A settle closure that yields REAL time before it renders twice. A lone ESC byte is an ambiguous
 * escape-sequence prefix: opentui's StdinParser holds it for its timeout (~20ms, on a real clock)
 * before flushing it as a standalone "escape" key. The dialog host applies initial focus on a
 * microtask and its lists' seeded scroll retries on a macrotask. So a pure `renderOnce` spin is too
 * early — only elapsed wall time puts those events on the other side of the render.
 */
export function makeSettle(setup: { renderOnce: () => Promise<void> }, ms: number): () => Promise<void> {
    return async () => {
        await Promise.sleep(ms);
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

/** {@link makeSettle}, then capture one character frame — the settle the dialog render tests assert on. */
export async function settleFrame(setup: RenderSetup, ms: number): Promise<string> {
    await makeSettle(setup, ms)();
    return setup.captureCharFrame();
}

/**
 * The resolved fg of the first captured span whose text contains `needle`, or undefined when none
 * rendered. A character frame cannot see a color, so span-level probes over `captureSpans` are how a
 * test asserts a role or tone survived the theme's resolution.
 */
export function spanFg(setup: RenderSetup, needle: string): RGBA | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (span.text.includes(needle)) return span.fg;
        }
    }
    return undefined;
}

/**
 * Render `node` and poll rendered frames until `needle` paints, and report whether it arrived before
 * the wait ran out.
 *
 * Blocks whose body goes through the markdown / code / diff renderables parse asynchronously, so a
 * single `renderOnce` can see an empty body and some waiting is unavoidable. But a wait that gives
 * up has to SAY it gave up: a caller that measures an ABSENCE — no sub-floor spans, no wrong colors,
 * a swallowed key — would read a blank screen from a timeout as a clean bill of health.
 *
 * `refocus` runs before each pass. Mount focus can race prop application, and focus() is idempotent,
 * so a caller that needs focus genuinely held at capture time re-asserts it every frame.
 */
export async function renderUntilPainted(
    node: Parameters<typeof testRender>[0],
    needle: string,
    size: { width: number; height: number },
    timeoutMs: number,
    refocus?: () => void,
): Promise<{ setup: RenderSetup; rendered: boolean }> {
    const setup = await testRender(node, size);
    const start = Date.now();
    for (;;) {
        refocus?.();
        await setup.renderOnce();
        if (setup.captureCharFrame().includes(needle)) return { setup, rendered: true };
        if (Date.now() - start > timeoutMs) return { setup, rendered: false };
        await Promise.sleep(10);
    }
}

/**
 * Render at `size`, poll until `needle` paints (or `timeoutMs` runs out), and give that frame. The
 * renderer is ALWAYS destroyed — even when the needle never came — because a leaked renderer holds
 * the native/terminal handles open and corrupts every later render suite in the same process.
 */
export async function frameWhenPainted(
    node: Parameters<typeof testRender>[0],
    size: { width: number; height: number },
    needle: string,
    timeoutMs: number,
): Promise<string> {
    const { setup } = await renderUntilPainted(node, needle, size, timeoutMs);
    try {
        return setup.captureCharFrame();
    } finally {
        setup.renderer.destroy();
    }
}

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

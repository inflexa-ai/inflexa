import { describe, expect, test } from "bun:test";

import { renderFrame } from "./tui.ts";

// Smoke-tests the whole headless render path (opentui testRender under bun:test + the [test] preload)
// so the §5.4 component tests can rely on it. Lives in a .tsx file because the helper takes JSX.

describe("renderFrame", () => {
    test("renders a component to a text frame and returns its glyphs", async () => {
        const frame = await renderFrame(() => <text>hello</text>, { width: 20, height: 3 });
        expect(frame).toContain("hello");
    });
});

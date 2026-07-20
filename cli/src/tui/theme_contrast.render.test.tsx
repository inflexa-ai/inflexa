import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type RGBA } from "@opentui/core";
import type { JSX } from "solid-js";

import { DEFAULT_THEME_ID, GLYPHS, themes } from "../lib/design_system.ts";
import { contrast } from "../test_support/contrast.ts";
import { setTheme, syntaxStyle, theme } from "./theme.ts";
import { AskPrompt } from "./components/ask_prompt.tsx";
import { DiffBlock } from "./components/diff_block.tsx";
import { ErrorBlock } from "./components/error_block.tsx";
import { OpenableCardBlock } from "./components/openable_card_block.tsx";
import { PlanCardBlock } from "./components/plan_card_block.tsx";
import { PresentationBlock } from "./components/presentation_block.tsx";
import { RunBlock } from "./components/run_block.tsx";
import { RunCardBlock } from "./components/run_card_block.tsx";
import { ThinkingBlock } from "./components/thinking_block.tsx";
import { ToolBlock } from "./components/tool_block.tsx";
import { Welcome } from "./components/welcome.tsx";
import { mockAskPrompts, mockFileEdit, mockPlanCard, mockRun, mockRunCard, mockThinking, mockToolCall } from "./layout/design_gallery_fixtures.ts";

// End-to-end guard for RENDERED contrast. captureCharFrame() gives characters only, so it cannot see
// this defect class — the failure is a COLOR, not a missing glyph. The test harness's captureSpans()
// exposes each rendered span's resolved fg (an RGBA), which is the mechanism this file asserts on.
//
// The defect class: opentui's text renderable defaults its foreground to opaque white, so a <text>
// (or an emphasis span with no colored ancestor) that names no fg silently paints #ffffff. On a light
// theme whose bg is pure #ffffff that is 1.00:1 — fully invisible, and invisible to a character-frame
// assertion too. github-light is the sharpest case, so every case here renders on it; its fg is
// #24292f (near-black), which is what a correctly-colored span resolves to.
//
// Two layers live here. The named cases below pin specific regressions where an un-captured span fell
// through to that white default (a markdown pipe-table DATA cell; a plain-text tool result the <code>
// renderable paints via setText with no highlights) — both verified against the counterfactual, so
// they genuinely fail if design_system.ts's "default" syntax scope or tool_block's <code> fg prop is
// reverted. The sweep below generalizes the same measurement across the block set, so a NEW block
// with an uncolored span is caught without anyone remembering to add a case for it.

const LIGHT = "github-light";
const WHITE = "#ffffff";

// The active theme is a module singleton; reset it after each case so order doesn't matter.
afterEach(() => {
    setTheme(DEFAULT_THEME_ID);
});

/** The fg of the FIRST captured span whose text contains `needle`, or undefined if none rendered. */
function spanFg(setup: Awaited<ReturnType<typeof testRender>>, needle: string): RGBA | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (span.text.includes(needle)) return span.fg;
        }
    }
    return undefined;
}

/** Render `node`, driving frames on real timers until `needle` appears (markdown/code parse async). */
async function renderUntil(
    node: Parameters<typeof testRender>[0],
    needle: string,
    size: { width: number; height: number } = { width: 60, height: 12 },
    timeoutMs = 3000,
): Promise<Awaited<ReturnType<typeof testRender>>> {
    const setup = await testRender(node, size);
    const start = Date.now();
    for (;;) {
        await setup.renderOnce();
        if (setup.captureCharFrame().includes(needle) || Date.now() - start > timeoutMs) return setup;
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe("theme-contrast AA: un-captured spans use the theme fg, not white", () => {
    test("a markdown pipe-table data cell renders in the theme fg", async () => {
        setTheme(LIGHT);
        const md = ["| Column |", "| --- |", "| CELLDATA |"].join("\n");
        // The production markdown config (see MessageBlock): fg + active syntaxStyle, streaming pinned true.
        const setup = await renderUntil(
            () => (
                <box width="100%" height="100%">
                    <markdown content={md} fg={theme().fg} syntaxStyle={syntaxStyle()} streaming={true} internalBlockMode="top-level" />
                </box>
            ),
            "CELLDATA",
        );
        try {
            const fg = spanFg(setup, "CELLDATA");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fg).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a ToolBlock plain-text result renders in the theme fg", async () => {
        setTheme(LIGHT);
        const setup = await renderUntil(
            () => (
                <box width="100%" height="100%">
                    <ToolBlock name="read_file" result={"UNIQUEPLAINTEXT no highlights here"} filetype="text" status="ok" />
                </box>
            ),
            "UNIQUEPLAINTEXT",
        );
        try {
            const fg = spanFg(setup, "UNIQUEPLAINTEXT");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fg).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep: every covered block's rendered spans must clear their contrast floor
// ─────────────────────────────────────────────────────────────────────────────

/** WCAG AA for text: information-bearing content must clear 4.5:1 against what it is painted on. */
const TEXT_FLOOR = 4.5;
/** WCAG AA for non-text UI: decoration whose loss does not impair the task is held to 3:1. */
const NON_TEXT_FLOOR = 3;

/**
 * Glyph shapes that carry no information of their own — box frames, progress-meter cells, and the
 * inline separator. `design_system.ts` deliberately tunes the `border` and `fgSubtle` tokens that
 * paint them to the 3:1 non-text floor rather than 4.5:1 (retuning `fgSubtle` to text contrast would
 * collapse it into `fgMuted`), so measuring these at the text floor would fail correct decoration.
 *
 * Named as GLYPHS keys rather than raw characters so the set cannot drift from the vocabulary it
 * describes: a retired or renamed glyph breaks this build instead of quietly relaxing a span's floor.
 */
const DECORATIVE_GLYPH_KEYS = [
    "lineHorizontal",
    "lineVertical",
    "cornerDownRight",
    "cornerDownLeft",
    "cornerUpRight",
    "cornerUpLeft",
    "teeDown",
    "teeUp",
    "teeRight",
    "teeLeft",
    "lineCross",
    "bar",
    "middot",
    // The not-yet-started marker. It belongs here for the same reason as the empty meter cell: both are
    // painted in `fgSubtle`, whose doc names "unselected gutter glyphs, empty meter cells, separators"
    // as the decorative tier and holds them to 3:1, and the palette matrix already blesses that pair.
    // Measuring it at the text floor would flag a token the design system tuned on purpose and push the
    // fix toward collapsing `fgSubtle` into `fgMuted` — which `design_system.ts` explicitly rejects.
    "circleHollow",
] as const satisfies readonly (keyof typeof GLYPHS)[];

const DECORATIVE_CHARS: ReadonlySet<string> = new Set(DECORATIVE_GLYPH_KEYS.map((key) => GLYPHS[key]));

/**
 * The floor a span must clear. A span counts as decoration only when EVERY character it paints is a
 * decorative glyph; a mixed span, or one holding any other character, falls to the stricter text
 * floor. Unclassified spans landing on the strict side is the point — the guard should fail loud on
 * something it does not recognize rather than wave it through under a relaxed threshold.
 */
function floorFor(trimmedText: string): number {
    for (const ch of trimmedText) {
        if (!DECORATIVE_CHARS.has(ch)) return TEXT_FLOOR;
    }
    return NON_TEXT_FLOOR;
}

/** One block rendered in isolation, exactly as the design gallery exhibits it. */
type BlockCase = {
    /** Block name, used in the violation message. */
    name: string;
    /** The block, wrapped in a full-size box so it lays out against the terminal surface. */
    node: () => JSX.Element;
    /**
     * Text that must be on screen before spans are read. Blocks whose body goes through the markdown
     * / code renderables parse asynchronously, so their content is absent from the first frame and a
     * single-frame capture would measure an empty block and pass vacuously.
     */
    until: string;
};

function noop(): void {
    // Blocks take their interaction callbacks as required props; the sweep only paints them.
}

// Fixtures come from the design gallery wherever a block has them, so the sweep measures the same
// content a reviewer sees in the gallery rather than a second, drifting set of sample data.
const BLOCKS: BlockCase[] = [
    {
        name: "Welcome",
        node: () => <Welcome greeting="welcome to inflexa" anchorPath="~/inflexa-tests" markerWritten={true} hints={["run /init", "ctrl+k for commands"]} />,
        until: "inflexa",
    },
    {
        name: "ThinkingBlock",
        node: () => <ThinkingBlock text={mockThinking.text} durationMs={mockThinking.durationMs} expanded />,
        until: "unique",
    },
    {
        name: "ToolBlock",
        node: () => (
            <ToolBlock name={mockToolCall.name} target={mockToolCall.target} result={mockToolCall.result} filetype={mockToolCall.filetype} status="ok" />
        ),
        until: "read_file",
    },
    {
        name: "RunBlock",
        node: () => <RunBlock name={mockRun.name} tag={mockRun.tag} done={mockRun.done} total={mockRun.total} steps={mockRun.steps} />,
        until: mockRun.tag,
    },
    {
        name: "DiffBlock",
        // The patch must PARSE. opentui's <diff> renders an unparseable patch as an error line in a
        // hardcoded #ef4444 on a private renderable with no fg seam for the embedder, so a malformed
        // fixture would measure opentui's error path rather than this block's themed one — a failure
        // no change to design_system.ts or diff_block.tsx could clear. mockFileEdit is well-formed.
        node: () => <DiffBlock path={mockFileEdit.path} diff={mockFileEdit.diff} added={mockFileEdit.added} removed={mockFileEdit.removed} />,
        // A token from the patch BODY, not its header: the header line is plain <text> painted on the
        // first frame, so waiting on it would read spans before the async diff parse produced any.
        until: "UNIQUE",
    },
    {
        name: "ErrorBlock",
        node: () => (
            <ErrorBlock
                summary="aborted (ctrl+c) · step 13 stopped, 12 kept"
                detail="EACCES · anchor not writable"
                note="marker_written=false → degraded to path-only; identity no longer self-heals on move."
                hints={["/reanchor", "r retry", "esc dismiss"]}
            />
        ),
        until: "aborted",
    },
    {
        name: "PlanCardBlock",
        node: () => <PlanCardBlock planId={mockPlanCard.planId} title={mockPlanCard.title} steps={mockPlanCard.steps} />,
        until: "8f21",
    },
    {
        name: "RunCardBlock",
        node: () => <RunCardBlock runId={mockRunCard.runId} title={mockRunCard.title} stepCount={mockRunCard.stepCount} />,
        until: "3c07",
    },
    {
        name: "PresentationBlock",
        node: () => (
            <PresentationBlock title="Key finding" body={{ kind: "markdown", body: "**TP53** is significantly upregulated (log2FC 2.4, _padj_ 3e-8)." }} />
        ),
        until: "TP53",
    },
    {
        name: "OpenableCardBlock",
        node: () => (
            <OpenableCardBlock
                title="Volcano plot"
                rows={[{ name: "Volcano plot", path: "~/proj/.inflexa/analyses/rna/presentations/pres-9f21a3.html", degraded: false }]}
                onOpen={noop}
            />
        ),
        until: "Volcano",
    },
    {
        name: "AskPrompt",
        node: () => (
            <AskPrompt
                title={mockAskPrompts.basic.title}
                command={mockAskPrompts.basic.command}
                queuedCount={mockAskPrompts.basic.queuedCount}
                inert
                onApprove={noop}
                onReject={noop}
            />
        ),
        until: "Approve",
    },
];

/**
 * Render one block on the light theme and describe every sub-floor span it painted. Each violation
 * names the block, the span text, the measured ratio and its floor, and the exact pair measured — a
 * bare list of booleans would say a block is broken without saying which line to look at.
 */
async function subAaSpans(block: BlockCase): Promise<string[]> {
    setTheme(LIGHT);
    // A span that paints no background of its own lands on the app surface the chat stream renders on.
    const surface = themes[LIGHT].colors.bg;
    const setup = await renderUntil(
        () => (
            <box width="100%" height="100%">
                {block.node()}
            </box>
        ),
        block.until,
        { width: 80, height: 24 },
    );
    try {
        // Keyed by message: a block repeats the same pair across rows (every border cell of a frame),
        // and one line per DISTINCT violation is what a reader needs.
        const violations = new Set<string>();
        for (const line of setup.captureSpans().lines) {
            for (const span of line.spans) {
                const text = span.text.trim();
                if (text.length === 0) continue;
                // rgbToHex appends an alpha byte ONLY for a non-opaque color, so a 7-char string is
                // exactly the "fully opaque" test. A transparent span bg means nothing was painted
                // behind the text; an opaque one is a real surface the span sits on — opentui carries
                // an ancestor box's backgroundColor into its spans, so a block on a raised panel is
                // measured against that panel, not against the app background behind it.
                const bgHex = rgbToHex(span.bg);
                const bg = bgHex.length === 7 ? bgHex : surface;
                // Drop any alpha byte: the luminance math reads the three color channels only.
                const fg = rgbToHex(span.fg).slice(0, 7);
                const floor = floorFor(text);
                const ratio = contrast(fg, bg);
                if (ratio < floor) violations.add(`${block.name} · "${text}" ${fg} on ${bg} = ${ratio.toFixed(2)}:1, need ${floor}:1`);
            }
        }
        return [...violations];
    } finally {
        setup.renderer.destroy();
    }
}

describe("theme-contrast AA: every block's rendered spans clear their floor", () => {
    for (const block of BLOCKS) {
        test(`${block.name} paints no sub-AA span`, async () => {
            expect(await subAaSpans(block)).toEqual([]);
        });
    }
});

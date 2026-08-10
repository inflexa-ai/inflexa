/**
 * The prose markup: the text block, the claim block, the section wrapper, and the page navigation.
 *
 * The runtime escapes every interpolated string, thus hostile prose reaches the page as text. A text
 * block and a claim block split the prose on a blank line, and each part becomes one paragraph. A claim
 * adds one marker for each binding, and the markers number through the shared ledger.
 */

import { raw } from "hono/html";

import type { ClaimBlock, SectionBlock, TextBlock } from "../../contracts/report-blocks.js";
import type { ReferenceLedger } from "../references.js";
import { Marker } from "./references-view.js";

/** The paragraph class of a text block and a claim block. */
const PARAGRAPH_CLASS = "report-paragraph mb-4 leading-relaxed text-slate-600";

/**
 * Split prose into paragraphs on a blank line. A run of blank lines makes one split. An empty part drops
 * out, thus a leading or a trailing blank line adds no empty paragraph.
 */
function splitParagraphs(prose: string): string[] {
    const parts = prose.split(/\n[ \t]*\n/);
    const paragraphs: string[] = [];
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.length > 0) {
            paragraphs.push(trimmed);
        }
    }
    return paragraphs;
}

/** Render a text block as escaped paragraphs. */
export function renderText(block: TextBlock): string {
    const paragraphs = splitParagraphs(block.content.prose);
    return String(
        <>
            {paragraphs.map((paragraph) => (
                <p class={PARAGRAPH_CLASS}>{paragraph}</p>
            ))}
        </>,
    );
}

/**
 * Render a claim block as escaped paragraphs plus evidence markers. The markers attach to the last
 * paragraph, thus they sit at the end of the claim text. The ledger marks each binding, thus a shared
 * reference keeps one number across the page.
 */
export function renderClaim(block: ClaimBlock, ledger: ReferenceLedger): string {
    const markerNumbers = block.bindings.map((reference) => ledger.mark(reference));
    const markers = markerNumbers.map((n) => <Marker n={n} />);
    const paragraphs = splitParagraphs(block.content.prose);
    if (paragraphs.length === 0) {
        return String(<p class={PARAGRAPH_CLASS}>{markers}</p>);
    }
    const last = paragraphs.length - 1;
    return String(
        <>
            {paragraphs.map((paragraph, index) => (
                <p class={PARAGRAPH_CLASS}>
                    {paragraph}
                    {index === last ? markers : null}
                </p>
            ))}
        </>,
    );
}

/** The heading class of a section, by heading level. */
function headingClass(level: number): string {
    switch (level) {
        case 2:
            return "text-3xl font-semibold tracking-tight text-slate-900 mb-4";
        case 3:
            return "text-2xl font-semibold tracking-tight text-slate-900 mb-3";
        default:
            return "text-xl font-semibold tracking-tight text-slate-900 mb-2";
    }
}

/**
 * Render a section wrapper around its rendered children. The heading level is `h2` at depth 0, `h3` at
 * depth 1, and `h4` at depth 2 or deeper. The walk renders the children first, and it passes the markup
 * as one already-escaped string, thus `raw()` inserts it byte for byte.
 */
export function renderSection(section: SectionBlock, depth: number, childrenHtml: string): string {
    const level = Math.min(depth + 2, 4);
    const Heading = `h${level}` as "h2" | "h3" | "h4";
    return String(
        <section id={section.id} class="report-section mb-10">
            <Heading class={headingClass(level)}>{section.title}</Heading>
            {raw(childrenHtml)}
        </section>,
    );
}

/**
 * Render the fixed left navigation. Each anchor targets one top-level section by its block id, with a
 * numeric badge for its position. The brand row stays, and the mobile toggle and the icon slot drop out.
 */
export function renderNav(topSections: SectionBlock[]): string {
    return String(
        <aside
            id="report-sidebar"
            class="fixed top-0 left-0 z-40 h-screen w-60 flex flex-col border-r border-slate-200 bg-white/95 backdrop-blur"
            aria-label="Report navigation"
        >
            <div class="flex items-center gap-2 px-5 py-5 border-b border-slate-200">
                <span class="font-mono text-sm font-semibold tracking-wider text-primary-500">inflexa</span>
            </div>
            <nav class="flex-1 overflow-y-auto py-3" aria-label="Report sections">
                {topSections.map((section, index) => (
                    <a
                        href={`#${section.id}`}
                        data-sidebar-link=""
                        class="sidebar-link flex items-center gap-3 px-5 py-2 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                    >
                        <span class="font-mono text-[10px] font-semibold tracking-wider text-slate-300 shrink-0 w-4 text-right">{index + 1}</span>
                        <span class="truncate">{section.title}</span>
                    </a>
                ))}
            </nav>
        </aside>,
    );
}

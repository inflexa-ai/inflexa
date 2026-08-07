/**
 * The prose renderers: the text block, the claim block, the section frame, and the page navigation.
 *
 * Each renderer escapes every interpolated string, thus hostile prose reaches the page as text. A text
 * block and a claim block split the prose on a blank line, and each part becomes one paragraph. A claim
 * adds one marker for each binding, and the markers number through the shared ledger.
 */

import type { ClaimBlock, SectionBlock, TextBlock } from "../contracts/report-blocks.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import { renderMarker, type ReferenceLedger } from "./references.js";

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
    const rendered = paragraphs.map((paragraph) => `<p class="${PARAGRAPH_CLASS}">${escapeHtml(paragraph)}</p>`);
    return rendered.join("\n");
}

/**
 * Render a claim block as escaped paragraphs plus evidence markers. The markers attach to the last
 * paragraph, thus they sit at the end of the claim text. The ledger marks each binding, thus a shared
 * reference keeps one number across the page.
 */
export function renderClaim(block: ClaimBlock, ledger: ReferenceLedger): string {
    const markers = block.bindings.map((reference) => renderMarker(ledger.mark(reference))).join("");
    const paragraphs = splitParagraphs(block.content.prose);
    if (paragraphs.length === 0) {
        return `<p class="${PARAGRAPH_CLASS}">${markers}</p>`;
    }
    const last = paragraphs.length - 1;
    const rendered = paragraphs.map((paragraph, index) => {
        const suffix = index === last ? markers : "";
        return `<p class="${PARAGRAPH_CLASS}">${escapeHtml(paragraph)}${suffix}</p>`;
    });
    return rendered.join("\n");
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
 * Open a section wrapper and a heading. The heading level is `h2` at depth 0, `h3` at depth 1, and `h4`
 * at depth 2 or deeper. The walk renders the children after this, and it closes the wrapper with
 * `renderSectionClose`.
 */
export function renderSectionOpen(section: SectionBlock, depth: number): string {
    const level = Math.min(depth + 2, 4);
    const id = escapeAttr(section.id);
    const title = escapeHtml(section.title);
    return `<section id="${id}" class="report-section mb-10">\n<h${level} class="${headingClass(level)}">${title}</h${level}>`;
}

/** Close a section wrapper. */
export function renderSectionClose(): string {
    return "</section>";
}

/**
 * Render the fixed left navigation. Each anchor targets one top-level section by its block id, with a
 * numeric badge for its position. The brand row stays, and the mobile toggle and the icon slot drop out.
 */
export function renderNav(topSections: SectionBlock[]): string {
    const anchors = topSections.map((section, index) => {
        const id = escapeAttr(section.id);
        const label = escapeHtml(section.title);
        const badge = String(index + 1);
        return [
            `<a href="#${id}" data-sidebar-link class="sidebar-link flex items-center gap-3 px-5 py-2 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors">`,
            `<span class="font-mono text-[10px] font-semibold tracking-wider text-slate-300 shrink-0 w-4 text-right">${badge}</span>`,
            `<span class="truncate">${label}</span>`,
            `</a>`,
        ].join("\n");
    });
    return [
        `<aside id="report-sidebar" class="fixed top-0 left-0 z-40 h-screen w-60 flex flex-col border-r border-slate-200 bg-white/95 backdrop-blur" aria-label="Report navigation">`,
        `<div class="flex items-center gap-2 px-5 py-5 border-b border-slate-200">`,
        `<span class="font-mono text-sm font-semibold tracking-wider text-primary-500">inflexa</span>`,
        `</div>`,
        `<nav class="flex-1 overflow-y-auto py-3" aria-label="Report sections">`,
        anchors.join("\n"),
        `</nav>`,
        `</aside>`,
    ].join("\n");
}

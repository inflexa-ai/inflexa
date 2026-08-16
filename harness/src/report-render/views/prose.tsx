/**
 * The prose markup: the text block, the claim block, the section wrapper, and the page navigation.
 *
 * The runtime escapes every interpolated string, thus hostile prose reaches the page as text. A text
 * block and a claim block split the prose on a blank line, and each part becomes one paragraph. A claim
 * adds one marker for each binding, and the markers number through the shared ledger.
 *
 * A text block also carries a typed list, and the list renders as list markup after the paragraphs. Each
 * item takes the same escape as a paragraph, thus no item reaches the page as markup.
 */

import { raw } from "hono/html";

import type { ClaimBlock, SectionBlock, TextBlock, TextList } from "../../contracts/report-blocks.js";
import type { ReferenceLedger } from "../references.js";
import { Marker } from "./references-view.js";

/** The paragraph class of a text block and a claim block. The paragraph fills the content column. */
const PARAGRAPH_CLASS = "report-prose";

/** The class of a rendered list. The list fills the content column, the same as a paragraph. */
const LIST_CLASS = "report-list";

/** The site that the navigation brand links to. It is the one reference of the page that leaves the page. */
const BRAND_HREF = "https://inflexa.ai/";

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

/**
 * One typed list as list markup. The flag selects the element: an ordered list numbers its items, and an
 * unordered one bullets them. Each item is one inline line, thus no item holds a list of its own.
 */
function TextListView({ list }: { list: TextList }) {
    const items = list.items.map((item) => <li class="report-list-item">{item}</li>);
    return list.ordered ? <ol class={LIST_CLASS}>{items}</ol> : <ul class={LIST_CLASS}>{items}</ul>;
}

/**
 * Render a text block as escaped paragraphs, and then its list.
 *
 * The lead sentences introduce the enumeration, thus the list comes after them. An empty prose gives no
 * paragraph, and a block with a list alone renders the list alone. A block with no list renders the
 * paragraphs alone, exactly as it did before the field existed.
 */
export function renderText(block: TextBlock): string {
    const paragraphs = splitParagraphs(block.content.prose);
    const list = block.content.list;
    return String(
        <>
            {paragraphs.map((paragraph) => (
                <p class={PARAGRAPH_CLASS}>{paragraph}</p>
            ))}
            {list !== undefined ? <TextListView list={list} /> : null}
        </>,
    );
}

/**
 * Render a claim block as escaped paragraphs plus evidence markers. The markers attach to the last
 * paragraph, thus they sit at the end of the claim text. The ledger marks each binding, thus a shared
 * reference keeps one number across the page. An artifact binding and a citation binding read the same
 * bracket, because one ladder counts them both.
 */
export function renderClaim(block: ClaimBlock, ledger: ReferenceLedger): string {
    const markers = block.bindings.map((reference) => <Marker n={ledger.mark(reference)} />);
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

/** The heading class of a section, by heading level. A heading uses the sans family, never the mono family. */
function headingClass(level: number): string {
    return `report-heading report-heading-${level}`;
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
        <section id={section.id} class="report-section">
            <Heading class={headingClass(level)}>{section.title}</Heading>
            {raw(childrenHtml)}
        </section>,
    );
}

/**
 * Render the fixed left navigation. Each anchor targets one top-level section by its block id, with a
 * numeric badge for its position. The brand row stays, and the mobile toggle and the icon slot drop out.
 * The `report-sidebar` id is the hook of the layout shift on a large viewport.
 */
export function renderNav(topSections: SectionBlock[]): string {
    return String(
        <aside id="report-sidebar" class="report-nav" aria-label="Report navigation">
            <div class="report-nav-brand">
                <a class="report-nav-brand-name" href={BRAND_HREF}>
                    inflexa
                </a>
            </div>
            <nav class="report-nav-list" aria-label="Report sections">
                {topSections.map((section, index) => (
                    <a href={`#${section.id}`} class="report-nav-link">
                        <span class="report-nav-index">{index + 1}</span>
                        <span class="report-nav-label">{section.title}</span>
                    </a>
                ))}
            </nav>
        </aside>,
    );
}

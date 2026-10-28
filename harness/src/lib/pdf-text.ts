/**
 * The text of a PDF, for each page, on `unpdf`: the serverless build of PDF.js, with no native part and no worker
 * file. Thus it runs under Node, under Bun, and in a Bun single-file binary.
 */

import { getDocumentProxy } from "unpdf";

/** The text of one page. */
export type PdfPageText = { readonly page: number; readonly text: string };

/** The pages that a read gave, and the page count of the whole document. */
export type PdfText = { readonly totalPages: number; readonly pages: readonly PdfPageText[] };

/** The text of the items of a page, with the line ends that PDF.js marks. A marked-content item carries no text. */
function pageText(items: readonly object[]): string {
    return items
        .map((item) => ("str" in item && typeof item.str === "string" ? `${item.str}${"hasEOL" in item && item.hasEOL === true ? "\n" : ""}` : ""))
        .join("")
        .trim();
}

/**
 * Read the text of the pages `first` to `last` of a PDF, both inclusive and 1-based, clamped to the document. The
 * whole document is never decoded: PDF.js parses a page when the read asks for it. A PDF that PDF.js cannot open
 * throws, and the caller maps the throw.
 */
export async function readPdfText(bytes: Uint8Array, range: { readonly first: number; readonly last: number }): Promise<PdfText> {
    // The verbosity 0 keeps the warnings of PDF.js off the console of the host.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
        const first = Math.max(1, range.first);
        const last = Math.min(pdf.numPages, range.last);
        const pages: PdfPageText[] = [];
        for (let page = first; page <= last; page++) {
            const content = await (await pdf.getPage(page)).getTextContent();
            pages.push({ page, text: pageText(content.items) });
        }
        return { totalPages: pdf.numPages, pages };
    } finally {
        await pdf.cleanup();
    }
}

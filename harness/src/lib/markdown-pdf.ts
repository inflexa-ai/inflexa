/**
 * A PDF from markdown, on `marked` and `pdfmake`, with no browser.
 *
 * `marked` gives the token tree, and each token maps to a `pdfmake` node: a heading, a paragraph, a list, a GFM table,
 * a code block, a quote, a rule, and an image. An SVG image, for example a chart of `render_chart`, lands as vector
 * graphics. The text font is the Roboto that `pdfmake` ships, which holds the Greek letters and the common math signs.
 *
 * `pdfmake` resolves a font by a file path, also inside an SVG, thus the fonts land one time in a private temporary
 * directory. Each URL is refused, and a local path is refused unless it is one of those font files, thus a document
 * reads nothing that the caller did not give it.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { z } from "zod";

/** An image that a document embeds. The caller reads the bytes, thus the document reaches no file and no URL. */
export type PdfImage = { readonly kind: "svg"; readonly svg: string } | { readonly kind: "png" | "jpeg"; readonly bytes: Uint8Array };

/** A node of a `pdfmake` document. */
type PdfNode = { readonly [key: string]: unknown };

/** The token kinds of the lexer of `marked`. */
const MARKED_KINDS: ReadonlySet<string> = new Set([
    "blockquote",
    "br",
    "checkbox",
    "code",
    "codespan",
    "def",
    "del",
    "em",
    "escape",
    "heading",
    "hr",
    "html",
    "image",
    "link",
    "list",
    "list_item",
    "paragraph",
    "space",
    "strong",
    "table",
    "tag",
    "text",
]);

/**
 * A token of one of the kinds of the lexer. No extension of `marked` is registered, thus a token with one of these
 * kinds has the shape of that kind.
 */
function isMarkedToken(token: Token): token is MarkedToken {
    return MARKED_KINDS.has(token.type);
}

/** The tokens of the lexer as its own kinds. */
function tokensOf(tokens: readonly Token[] | undefined): readonly MarkedToken[] {
    return (tokens ?? []).filter(isMarkedToken);
}

const FontFilesSchema = z.record(z.string(), z.string());

/** The width of the text block of an A4 page with the margins of {@link documentOf}, in points. */
const TEXT_WIDTH = 515;

const FONT_FILES = {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Medium.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-MediumItalic.ttf",
} as const;

type PdfMake = typeof import("pdfmake").default;

let ready: Promise<PdfMake> | undefined;

/** The `pdfmake` instance with the fonts on disk and the access policies set. It is set up one time for each process. */
function pdfmakeOf(): Promise<PdfMake> {
    ready ??= (async () => {
        const { default: pdfmake } = await import("pdfmake");
        const vfsModule: unknown = await import("pdfmake/build/vfs_fonts.js");
        const vfs = FontFilesSchema.parse(Reflect.get(Object(vfsModule), "default"));
        const dir = await mkdtemp(join(tmpdir(), "pdf-fonts-"));
        const paths: Record<string, string> = {};
        for (const [style, file] of Object.entries(FONT_FILES)) {
            const data = vfs[file];
            if (data === undefined) throw new Error(`pdfmake ships no font file ${file}`);
            paths[style] = join(dir, file);
            await writeFile(join(dir, file), Buffer.from(data, "base64"));
        }
        const fontPaths = new Set(Object.values(paths));
        pdfmake.setFonts({ Roboto: paths });
        pdfmake.setUrlAccessPolicy(() => false);
        pdfmake.setLocalAccessPolicy((path) => fontPaths.has(path));
        return pdfmake;
    })();
    return ready;
}

/** The text runs of inline tokens, with the styles of the marks that hold them. */
function inline(tokens: readonly Token[] | undefined, images: ReadonlyMap<string, PdfImage>): PdfNode[] {
    const out: PdfNode[] = [];
    for (const token of tokensOf(tokens)) {
        switch (token.type) {
            case "strong":
                out.push({ text: inline(token.tokens, images), bold: true });
                break;
            case "em":
                out.push({ text: inline(token.tokens, images), italics: true });
                break;
            case "del":
                out.push({ text: inline(token.tokens, images), decoration: "lineThrough" });
                break;
            case "codespan":
                out.push({ text: token.text, background: "#f2f2f2" });
                break;
            case "link":
                out.push({ text: inline(token.tokens, images), link: token.href, color: "#1a5fb4", decoration: "underline" });
                break;
            case "br":
                out.push({ text: "\n" });
                break;
            case "image":
                out.push({ text: token.text, italics: true });
                break;
            case "text":
                out.push(token.tokens === undefined ? { text: token.text } : { text: inline(token.tokens, images) });
                break;
            case "escape":
                out.push({ text: token.text });
                break;
            default:
                out.push({ text: token.raw });
        }
    }
    return out;
}

/** An image of a paragraph that holds one image alone, with its alt text as the caption. */
function imageNode(token: Tokens.Image, images: ReadonlyMap<string, PdfImage>): PdfNode[] {
    const image = images.get(token.href);
    const caption = token.text.length > 0 ? [{ text: token.text, style: "caption" }] : [];
    if (image === undefined) return [{ text: `[${token.text || token.href}]`, italics: true }];
    if (image.kind === "svg") return [{ svg: image.svg, width: TEXT_WIDTH, margin: [0, 6, 0, 2] }, ...caption];
    const data = `data:image/${image.kind};base64,${Buffer.from(image.bytes).toString("base64")}`;
    return [{ image: data, fit: [TEXT_WIDTH, 600], margin: [0, 6, 0, 2] }, ...caption];
}

function blocks(tokens: readonly Token[] | undefined, images: ReadonlyMap<string, PdfImage>): PdfNode[] {
    const out: PdfNode[] = [];
    for (const token of tokensOf(tokens)) {
        switch (token.type) {
            case "heading":
                out.push({ text: inline(token.tokens, images), style: `h${String(Math.min(token.depth, 4))}` });
                break;
            case "paragraph": {
                const parts = tokensOf(token.tokens);
                const only = parts.length === 1 ? parts[0] : undefined;
                if (only?.type === "image") out.push(...imageNode(only, images));
                else out.push({ text: inline(token.tokens, images), style: "paragraph" });
                break;
            }
            case "list":
                out.push({
                    [token.ordered ? "ol" : "ul"]: token.items.map((item) => ({ stack: blocks(item.tokens, images) })),
                    style: "list",
                });
                break;
            case "table":
                out.push({
                    table: {
                        headerRows: 1,
                        widths: token.header.map(() => "*"),
                        body: [
                            token.header.map((cell) => ({ text: inline(cell.tokens, images), bold: true })),
                            ...token.rows.map((row) => row.map((cell) => ({ text: inline(cell.tokens, images) }))),
                        ],
                    },
                    layout: "lightHorizontalLines",
                    style: "table",
                });
                break;
            case "code":
                out.push({ text: token.text, style: "code", preserveLeadingSpaces: true });
                break;
            case "blockquote":
                out.push({ stack: blocks(token.tokens, images), style: "quote" });
                break;
            case "hr":
                out.push({ canvas: [{ type: "line", x1: 0, y1: 0, x2: TEXT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: "#999999" }], margin: [0, 8, 0, 8] });
                break;
            case "text":
                out.push({ text: inline(token.tokens, images), style: "paragraph" });
                break;
            default:
                // A space, an HTML block, or a link definition prints nothing.
                break;
        }
    }
    return out;
}

/** The source of each image of a markdown text, in the order of the text. */
export function markdownImageSources(markdown: string): string[] {
    const sources: string[] = [];
    const walk = (tokens: readonly Token[] | undefined): void => {
        for (const token of tokensOf(tokens)) {
            if (token.type === "image") sources.push(token.href);
            if (token.type === "list") for (const item of token.items) walk(item.tokens);
            else if (token.type === "table") for (const cell of [...token.header, ...token.rows.flat()]) walk(cell.tokens);
            else if ("tokens" in token) walk(token.tokens);
        }
    };
    walk(lexer(markdown));
    return [...new Set(sources)];
}

function documentOf(markdown: string, title: string | undefined, images: ReadonlyMap<string, PdfImage>): Record<string, unknown> {
    return {
        info: title === undefined ? {} : { title },
        pageSize: "A4",
        pageMargins: [40, 48, 40, 48],
        content: [...(title === undefined ? [] : [{ text: title, style: "title" }]), ...blocks(lexer(markdown), images)],
        defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.25 },
        styles: {
            title: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] },
            h1: { fontSize: 16, bold: true, margin: [0, 12, 0, 6] },
            h2: { fontSize: 13, bold: true, margin: [0, 10, 0, 4] },
            h3: { fontSize: 11, bold: true, margin: [0, 8, 0, 4] },
            h4: { fontSize: 10, bold: true, margin: [0, 6, 0, 2] },
            paragraph: { margin: [0, 0, 0, 6] },
            list: { margin: [0, 0, 0, 6] },
            table: { fontSize: 9, margin: [0, 4, 0, 8] },
            code: { fontSize: 8.5, background: "#f2f2f2", margin: [0, 2, 0, 8] },
            quote: { color: "#555555", italics: true, margin: [12, 0, 0, 6] },
            caption: { fontSize: 8.5, italics: true, color: "#555555", alignment: "center", margin: [0, 0, 0, 8] },
        },
    };
}

/** The PDF of a markdown text. `images` holds each image that the text names, by its source. */
export async function markdownToPdf(args: {
    readonly markdown: string;
    readonly title?: string;
    readonly images: ReadonlyMap<string, PdfImage>;
}): Promise<Uint8Array> {
    const pdfmake = await pdfmakeOf();
    return pdfmake.createPdf(documentOf(args.markdown, args.title, args.images)).getBuffer();
}

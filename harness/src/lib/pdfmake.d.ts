// pdfmake ships no types. This declares the server API of pdfmake 0.3 that `lib/markdown-pdf.ts` calls.

declare module "pdfmake" {
    type PdfMake = {
        setFonts(fonts: Record<string, Record<string, string>>): void;
        setUrlAccessPolicy(allow: (url: string) => boolean): void;
        setLocalAccessPolicy(allow: (path: string) => boolean): void;
        createPdf(document: Record<string, unknown>): { getBuffer(): Promise<Uint8Array> };
    };
    const pdfmake: PdfMake;
    // oxlint-disable-next-line @inflexa-ai/export-at-declaration -- the package exports one instance through `module.exports`, and an ambient module has no default form for a const declaration.
    export default pdfmake;
}

// The base64 of each font file that pdfmake ships, by file name. A reader parses it.
declare module "pdfmake/build/vfs_fonts.js";

/**
 * A minimal single-font PDF with one text line per page, `latin1`-encoded. It carries just enough structure
 * for the PDF text extractors of the suites to read one body line per page.
 */

export function buildPdf(pageCount: number): Buffer {
    const objects: string[] = ["1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj"];
    const kids = Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
    objects.push(`2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>endobj`, `3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);
    for (let i = 0; i < pageCount; i++) {
        const content = `BT /F1 12 Tf 72 720 Td (Page ${i + 1} body text) Tj ET`;
        objects.push(
            `${4 + i * 2} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${5 + i * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj`,
            `${5 + i * 2} 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
        );
    }
    return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\ntrailer<</Size ${3 + pageCount * 2}/Root 1 0 R>>`, "latin1");
}

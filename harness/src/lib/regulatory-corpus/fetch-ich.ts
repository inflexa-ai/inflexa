/**
 * Fetcher for ICH (International Council for Harmonisation) guidelines.
 * Returns a curated catalog of canonical guidelines and downloads each PDF.
 *
 * Series:
 *   S — Safety (nonclinical safety pharmacology, toxicology)
 *   E — Efficacy (clinical study design, statistical principles)
 *   M — Multidisciplinary
 *   Q — Quality (CMC)
 *
 * Codes look like S7A, E14, M3(R2), Q1A. The doc_id we emit is
 * `ich-<code>` with non-word chars sanitized.
 */

import { PDFParse } from "pdf-parse";

export type IchSeries = "S" | "E" | "M" | "Q";

export interface IchStub {
    doc_id: string;
    doc_title: string;
    doc_url: string;
    code: string;
    series: IchSeries;
    metadata?: { year?: string };
}

export interface IchDoc {
    doc_id: string;
    doc_title: string;
    doc_url: string;
    text: string;
    metadata: { code: string; series: IchSeries; year?: string };
}

/**
 * Curated catalog of ICH guidelines to index into the corpus.
 *
 * The ICH guidelines listing at ich.org is an Angular SPA (the server
 * returns 687 bytes of `<app-root>` shell), and the admin REST API
 * (`admin.ich.org/api/v1/nodes`) does not expose paragraph entities, so
 * the per-section guideline lists never reach a `fetch + cheerio` consumer.
 * Rather than scraping behind a headless browser, we maintain a hand-picked
 * list of canonical guidelines covering the safety, efficacy, and quality
 * ground that Cortex agents most often need to cite.
 *
 * URLs target the stable PDFs at `database.ich.org/sites/default/files/...`.
 * Filenames are inconsistent across guidelines (some include a Step-4
 * date, some are bare); add new entries by visiting the corresponding
 * `/page/<series>-guidelines` page in a browser, copying the PDF link,
 * and verifying it returns `application/pdf`.
 */
const ICH_GUIDELINES: ReadonlyArray<{
    code: string;
    series: IchSeries;
    doc_title: string;
    url: string;
}> = [
    // Safety
    {
        code: "S7A",
        series: "S",
        doc_title: "Safety Pharmacology Studies for Human Pharmaceuticals",
        url: "https://database.ich.org/sites/default/files/S7A_Guideline.pdf",
    },
    {
        code: "S7B",
        series: "S",
        doc_title: "Nonclinical Evaluation of the Potential for Delayed Ventricular Repolarization (QT Interval Prolongation) by Human Pharmaceuticals",
        url: "https://database.ich.org/sites/default/files/S7B_Guideline.pdf",
    },
    {
        code: "S9",
        series: "S",
        doc_title: "Nonclinical Evaluation for Anticancer Pharmaceuticals",
        url: "https://database.ich.org/sites/default/files/S9_Guideline.pdf",
    },
    // Multidisciplinary
    {
        code: "M3(R2)",
        series: "M",
        doc_title: "Nonclinical Safety Studies for the Conduct of Human Clinical Trials and Marketing Authorization for Pharmaceuticals",
        url: "https://database.ich.org/sites/default/files/M3_R2__Guideline.pdf",
    },
    // Efficacy
    {
        code: "E14",
        series: "E",
        doc_title: "Clinical Evaluation of QT/QTc Interval Prolongation and Proarrhythmic Potential for Non-Antiarrhythmic Drugs",
        url: "https://database.ich.org/sites/default/files/E14_Guideline.pdf",
    },
    {
        code: "E6(R3)",
        series: "E",
        doc_title: "Good Clinical Practice (GCP)",
        url: "https://database.ich.org/sites/default/files/ICH_E6%28R3%29_Step4_FinalGuideline_2025_0106.pdf",
    },
    {
        code: "E8(R1)",
        series: "E",
        doc_title: "General Considerations for Clinical Studies",
        url: "https://database.ich.org/sites/default/files/ICH_E8-R1_Guideline_Step4_2021_1006.pdf",
    },
    {
        code: "E9(R1)",
        series: "E",
        doc_title: "Statistical Principles for Clinical Trials (Addendum: Estimands and Sensitivity Analysis)",
        url: "https://database.ich.org/sites/default/files/E9-R1_Step4_Guideline_2019_1203.pdf",
    },
    {
        code: "E11(R1)",
        series: "E",
        doc_title: "Clinical Investigation of Medicinal Products in the Pediatric Population (Addendum)",
        url: "https://database.ich.org/sites/default/files/E11_R1_Addendum.pdf",
    },
    // Quality
    {
        code: "Q1A(R2)",
        series: "Q",
        doc_title: "Stability Testing of New Drug Substances and Products",
        url: "https://database.ich.org/sites/default/files/Q1A%28R2%29%20Guideline.pdf",
    },
    {
        code: "Q3D(R2)",
        series: "Q",
        doc_title: "Guideline for Elemental Impurities",
        url: "https://database.ich.org/sites/default/files/Q3D-R2_Guideline_Step4_2022_0308.pdf",
    },
    {
        code: "Q8(R2)",
        series: "Q",
        doc_title: "Pharmaceutical Development",
        url: "https://database.ich.org/sites/default/files/Q8%28R2%29%20Guideline.pdf",
    },
    {
        code: "Q9",
        series: "Q",
        doc_title: "Quality Risk Management",
        url: "https://database.ich.org/sites/default/files/Q9%20Guideline.pdf",
    },
    {
        code: "Q10",
        series: "Q",
        doc_title: "Pharmaceutical Quality System",
        url: "https://database.ich.org/sites/default/files/Q10%20Guideline.pdf",
    },
];

/**
 * Return the curated ICH guideline stubs. The catalog is static; this
 * function exists for parity with `fetchFdaGuidanceListing()` and as the
 * seam where a future contributor can swap in dynamic discovery.
 */
export async function fetchIchListing(): Promise<IchStub[]> {
    return ICH_GUIDELINES.map((g) => ({
        doc_id: `ich-${slugify(g.code)}`,
        doc_title: g.doc_title,
        doc_url: g.url,
        code: g.code,
        series: g.series,
    }));
}

/**
 * Download a single ICH guideline PDF and extract its text. Returns
 * normalized whitespace-collapsed text suitable for chunking.
 */
export async function fetchAndExtractIchDoc(stub: IchStub): Promise<IchDoc> {
    const res = await fetch(stub.doc_url);
    if (!res.ok) {
        throw new Error(`fetch ${stub.doc_url}: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    await parser.destroy();

    return {
        doc_id: stub.doc_id,
        doc_title: stub.doc_title,
        doc_url: stub.doc_url,
        text: normalizeWhitespace(result.text),
        metadata: {
            code: stub.code,
            series: stub.series,
            year: stub.metadata?.year,
        },
    };
}

function normalizeWhitespace(s: string): string {
    return s
        .replace(/[ \t]+/g, " ")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

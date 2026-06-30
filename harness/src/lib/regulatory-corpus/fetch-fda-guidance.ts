import { load } from "cheerio";
import { PDFParse } from "pdf-parse";

export type FdaCenter = "CDER" | "CBER";

export interface FdaDocStub {
    doc_id: string;
    doc_title: string;
    doc_url: string;
    center: FdaCenter;
    metadata?: { year?: string; category?: string };
}

export interface FdaDoc {
    doc_id: string;
    doc_title: string;
    doc_url: string;
    text: string;
    metadata: { center: FdaCenter; year?: string; category?: string };
}

/**
 * Curated catalog of FDA guidance documents to index into the corpus.
 *
 * The FDA listing page (`/regulatory-information/search-fda-guidance-documents`)
 * is a Drupal datatable rendered client-side from
 * `/datatables-json/search-for-guidance.json`, and Akamai's edge returns
 * 503 to non-browser fetches. Rather than scraping behind a headless
 * browser, we maintain a hand-picked list of canonical guidances most
 * relevant to the safety, translational, and clinical-evaluation work
 * Cortex agents do.
 *
 * Each entry is keyed by the FDA media ID at `https://www.fda.gov/media/{id}/download`.
 * Media IDs are stable: once issued they don't get renumbered when the
 * underlying PDF is revised. To add an entry, open the guidance's
 * `/regulatory-information/search-fda-guidance-documents/{slug}` page and
 * grab the `Download` link's `/media/{id}/download` href.
 */
const FDA_GUIDANCES: ReadonlyArray<{
    center: FdaCenter;
    doc_id: string;
    doc_title: string;
    media_id: string;
    year?: string;
}> = [
    {
        center: "CDER",
        doc_id: "fda-cder-bioanalytical-method-validation",
        doc_title: "Bioanalytical Method Validation Guidance for Industry",
        media_id: "70858",
        year: "2018",
    },
    {
        center: "CDER",
        doc_id: "fda-cder-safety-testing-of-drug-metabolites",
        doc_title: "Safety Testing of Drug Metabolites",
        media_id: "72279",
        year: "2020",
    },
    {
        center: "CDER",
        doc_id: "fda-cder-estimating-maximum-safe-starting-dose",
        doc_title: "Estimating the Maximum Safe Starting Dose in Initial Clinical Trials for Therapeutics in Adult Healthy Volunteers",
        media_id: "72309",
        year: "2005",
    },
    {
        center: "CDER",
        doc_id: "fda-cder-drug-induced-liver-injury",
        doc_title: "Drug-Induced Liver Injury: Premarketing Clinical Evaluation",
        media_id: "116737",
        year: "2009",
    },
];

/**
 * Return the curated FDA guidance stubs for `center`. The catalog is
 * static; this function exists for parity with `fetchIchListing()` and as
 * the seam where a future contributor can swap in dynamic discovery
 * (e.g., headless-browser scraping or a vetted third-party index).
 */
export async function fetchFdaGuidanceListing(center: FdaCenter): Promise<FdaDocStub[]> {
    return FDA_GUIDANCES.filter((g) => g.center === center).map((g) => ({
        doc_id: g.doc_id,
        doc_title: g.doc_title,
        doc_url: `https://www.fda.gov/media/${g.media_id}/download`,
        center: g.center,
        metadata: { year: g.year },
    }));
}

/**
 * Download a single FDA guidance document and extract its text. Handles
 * both HTML and PDF formats (FDA serves a mix). Returns normalized
 * whitespace-collapsed text suitable for chunking.
 */
export async function fetchAndExtractFdaDoc(stub: FdaDocStub): Promise<FdaDoc> {
    const res = await fetch(stub.doc_url);
    if (!res.ok) {
        throw new Error(`fetch ${stub.doc_url}: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();

    let text: string;
    if (ct.includes("pdf") || stub.doc_url.toLowerCase().endsWith(".pdf")) {
        const parser = new PDFParse({ data: buf });
        const result = await parser.getText();
        await parser.destroy();
        text = result.text;
    } else {
        const $ = load(buf.toString("utf-8"));
        // Prefer <main> when present; fall back to body.
        text = ($("main").length > 0 ? $("main") : $("body")).text();
    }

    return {
        doc_id: stub.doc_id,
        doc_title: stub.doc_title,
        doc_url: stub.doc_url,
        text: normalizeWhitespace(text),
        metadata: {
            center: stub.center,
            year: stub.metadata?.year,
            category: stub.metadata?.category,
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

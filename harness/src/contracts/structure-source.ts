/**
 * The source of a `kind: "structure"` presentation card — the one grammar that
 * admits a coordinate-file URL, shared by the harness (card construction) and
 * by a host (render time).
 *
 * Admission is a path grammar over one host, not a host check: a hostname test
 * alone would admit the prediction API and the PAE image on the same host. The
 * grammar names the one kind of object a card can hold — a versioned AlphaFold
 * DB model file — and derives from it what the host displays (`accession`,
 * `version`) and what its purged-version fallback needs. A host re-runs the same
 * parse over a persisted `url` before it fetches, so a card the harness would
 * refuse today is refused at render time too.
 *
 * This module is browser-safe: it imports nothing.
 */

export type StructureFormat = "pdb" | "mmcif";

export interface StructureSource {
    readonly provider: "alphafold";
    /** The UniProt accession the model is keyed by, isoform suffix included (`P38398-2`). */
    readonly accession: string;
    /** The AlphaFold DB model version the URL names. */
    readonly version: number;
    readonly format: StructureFormat;
    /** The normalized file URL — what a host fetches and what the transcript attests to. */
    readonly url: string;
}

const ALPHAFOLD_ORIGIN = "https://alphafold.ebi.ac.uk";

/** `/files/AF-{accession}-F{fragment}-model_v{version}.{pdb|cif}` — the AlphaFold DB file path shape. */
const ALPHAFOLD_FILE_PATH = /^\/files\/AF-([A-Z0-9]+(?:-\d+)?)-F\d+-model_v(\d+)\.(pdb|cif)$/;

/**
 * Parse a structure URL into its source, or `null` when the grammar refuses it.
 *
 * Admits exactly: scheme `https`, host `alphafold.ebi.ac.uk` with no port or
 * credential, the AlphaFold file path, and no query or fragment. `.pdb` maps to
 * `pdb` and `.cif` to `mmcif`; the binary `.bcif` is not admitted.
 */
export function parseStructureUrl(url: string): StructureSource | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.origin !== ALPHAFOLD_ORIGIN) return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (parsed.search !== "" || parsed.hash !== "") return null;

    const match = ALPHAFOLD_FILE_PATH.exec(parsed.pathname);
    if (match === null) return null;
    const version = Number(match[2]);
    if (!Number.isInteger(version) || version < 1) return null;

    return {
        provider: "alphafold",
        accession: match[1]!,
        version,
        format: match[3] === "pdb" ? "pdb" : "mmcif",
        url: parsed.href,
    };
}

/** The AlphaFold DB entry page of an accession. */
export function alphafoldEntryUrl(accession: string): string {
    return `${ALPHAFOLD_ORIGIN}/entry/${encodeURIComponent(accession)}`;
}

/** The AlphaFold DB prediction endpoint of an accession — what a host re-resolves a purged version through. */
export function alphafoldPredictionUrl(accession: string): string {
    return `${ALPHAFOLD_ORIGIN}/api/prediction/${encodeURIComponent(accession)}`;
}

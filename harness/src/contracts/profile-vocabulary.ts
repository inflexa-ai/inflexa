/**
 * The controlled vocabulary the profiler draws from, as data.
 *
 * One source, two readers: submit validation derives its enums from these lists and
 * prompt assembly renders from the same entries, so the catalogue the agent is shown
 * and the catalogue the validator enforces cannot diverge. Growth is an edit to these
 * lists, measured by how often `other` is reached for.
 *
 * It lives in `contracts/` because the persisted profile carries these ids: a consumer
 * rendering a stored group needs the category's meaning without importing the ledger,
 * the schema module, or zod. Hosts do not extend it — the package owns the catalogue and
 * versions it with the harness.
 *
 * Every category carries its nearest neighbour and the rule that separates them, because
 * a category list without one is a list of labels an author picks by vibe. Every
 * dimension category additionally carries a default treatment: whether a downstream step
 * would TYPICALLY consume one value's files as a different substrate than another's.
 * The agent follows the default and deviates only with a stated reason.
 */

// ── Group roles ────────────────────────────────────────────────────────────

export const GROUP_ROLE_IDS = ["data", "metadata", "index", "documentation", "reference"] as const;
export type GroupRole = (typeof GROUP_ROLE_IDS)[number];

export interface GroupRoleEntry {
    readonly id: GroupRole;
    readonly definition: string;
}

/**
 * Companions (`.bai`/`.tbi`/per-file `.md5`) take no role — they attach to members. A
 * checksum or inventory file spanning MANY members is not a companion but a member of
 * its own, category `manifest`; `index` is for tables that exist to be joined against,
 * never for binary sidecars.
 */
export const GROUP_ROLES: readonly GroupRoleEntry[] = [
    { id: "data", definition: "The measurements themselves — variant calls, a count matrix, images." },
    { id: "metadata", definition: "Describes other members' meaning or provenance — a sample sheet, a pipeline manifest, config files." },
    { id: "index", definition: "Standalone lookup or join tables — a variable-code dictionary, a file inventory table." },
    { id: "documentation", definition: "Prose for humans — README, dataset card, methods paper, licences." },
    {
        id: "reference",
        definition: "External or canonical inputs the analysis consumes but did not produce — genome build, annotation GTF, compound library, pathway sets.",
    },
];

// ── Group categories ───────────────────────────────────────────────────────

export const GROUP_CATEGORY_IDS = [
    "sequencing-reads",
    "alignment",
    "variant-calls",
    "copy-number",
    "structural-variants",
    "association-results",
    "regions-signal",
    "expression-matrix",
    "single-cell-matrix",
    "methylation",
    "proteomics",
    "metabolomics",
    "cytometry",
    "chemical-structures",
    "imaging",
    "clinical-table",
    "sample-annotation",
    "code",
    "document",
    "manifest",
    "reference-data",
    "other",
] as const;
export type GroupCategory = (typeof GROUP_CATEGORY_IDS)[number];

export interface GroupCategoryEntry {
    readonly id: GroupCategory;
    readonly definition: string;
    /** The nearest neighbour and the rule that separates them. */
    readonly note: string;
}

/**
 * Coarse on purpose — a free `subtype` refines below the category. Content beats shape:
 * a beta-value matrix is methylation whatever its layout, and a MAF is variant-calls
 * whatever its extension. Grain and meaning decide.
 */
export const GROUP_CATEGORIES: readonly GroupCategoryEntry[] = [
    {
        id: "sequencing-reads",
        definition: "Reads or raw instrument signal — FASTQ, unaligned BAM, FAST5/POD5.",
        note: "vs alignment: mapped-ness decides — an unaligned BAM is reads.",
    },
    {
        id: "alignment",
        definition: "Reads mapped to a reference — BAM/CRAM carrying mapped records.",
        note: "vs sequencing-reads: an unaligned BAM is reads, whatever the container.",
    },
    {
        id: "variant-calls",
        definition: "Per-sample small-variant calls (SNV/indel) — VCF with genotypes, MAF.",
        note: "vs copy-number/structural-variants: those products get their own category whatever the container. vs association-results: per-sample genotypes rather than cohort statistics. vs reference-data: a sites-only population or annotation VCF is reference-data, role reference.",
    },
    {
        id: "copy-number",
        definition: "Copy-number products — segment tables, ratio tracks, CNV calls.",
        note: "vs variant-calls: small variants stay variant-calls.",
    },
    {
        id: "structural-variants",
        definition: "Structural-variant products — breakpoints, SV calls.",
        note: "vs variant-calls: an SV VCF is structural-variants.",
    },
    {
        id: "association-results",
        definition: "Per-variant or per-feature summary statistics without per-sample data — GWAS/QTL sumstats, PLINK output.",
        note: "vs regions-signal: test statistics rather than positions or coverage.",
    },
    {
        id: "regions-signal",
        definition: "Genomic intervals and coverage tracks — BED/narrowPeak/broadPeak, bigWig/bedGraph.",
        note: "vs association-results: positions and coverage rather than test statistics.",
    },
    {
        id: "expression-matrix",
        definition: "Bulk feature × sample abundance tables.",
        note: "vs single-cell-matrix: barcoded per-cell products are single-cell. vs methylation: content beats shape — a beta-value matrix is methylation.",
    },
    {
        id: "single-cell-matrix",
        definition: "Barcoded per-cell products — MEX triplets, h5ad. Spatial omics is a subtype.",
        note: "vs expression-matrix: bulk gene × sample tables are expression.",
    },
    {
        id: "methylation",
        definition: "Methylation measurements — beta/M-value matrices, per-CpG calls.",
        note: "vs expression-matrix: the measured substrate decides, not the table's shape.",
    },
    {
        id: "proteomics",
        definition: "Protein-level measurements. MS rawness is a subtype.",
        note: "vs imaging: an imaging mass-spec run is proteomics with subtype 'imaging MS' — assay substrate wins.",
    },
    {
        id: "metabolomics",
        definition: "Metabolite-level measurements. MS rawness is a subtype.",
        note: "vs proteomics: by measured substrate.",
    },
    {
        id: "cytometry",
        definition: "Flow or mass cytometry — FCS and its derivatives.",
        note: "vs imaging: per-event measurements rather than pixels; vs proteomics: neither.",
    },
    {
        id: "chemical-structures",
        definition: "Compound structures and libraries — SDF, SMILES, MOL.",
        note: "vs reference-data: a screening library the analysis measures against is reference-data, role reference.",
    },
    {
        id: "imaging",
        definition: "Microscopy, radiology, and other pixel data — DICOM, TIFF stacks.",
        note: "vs cytometry: pixels rather than per-event measurements.",
    },
    {
        id: "clinical-table",
        definition: "Facts about subjects over time — diagnoses, medications, outcomes, visits.",
        note: "vs sample-annotation: subject grain rather than specimen grain. When one table does both, prefer sample-annotation only if its grain is the sample.",
    },
    {
        id: "sample-annotation",
        definition: "Specimen or measurement attribute maps — sample sheets, characteristic tables.",
        note: "vs clinical-table: specimen attributes rather than subject history.",
    },
    {
        id: "code",
        definition: "Scripts, notebooks, and workflow definitions arriving as inputs.",
        note: "vs document: executable rather than prose — a notebook is code even when narrated.",
    },
    {
        id: "document",
        definition: "Prose for humans — README, dataset card, methods paper, licence.",
        note: "vs manifest: a dataset card in Markdown is a document; its JSON twin is a manifest.",
    },
    {
        id: "manifest",
        definition: "Machine-readable inventories of these files — checksum lists, file manifests.",
        note: "vs index role: an inventory OF these files is a manifest; a table that exists to be joined against data is index-role.",
    },
    {
        id: "reference-data",
        definition: "Consumed-not-produced canonical inputs — genome builds, GTFs, pathway sets, spectral libraries, sites-only VCFs.",
        note: "vs everything: the analysis consumes it and did not produce it.",
    },
    {
        id: "other",
        definition: "Outside the catalogue — carry a free label saying what it is.",
        note: "A wrong specific category is worse than an honest `other` with a good label. Electrophysiology, phylogenetic trees, model weights, database dumps, and plate-reader tables belong here today.",
    },
];

// ── Dimension categories ───────────────────────────────────────────────────

export const DIMENSION_CATEGORY_IDS = [
    "subject",
    "sample",
    "organism-species",
    "model-system",
    "cohort-arm",
    "disease-state",
    "treatment",
    "timepoint",
    "tissue-site",
    "cell-type",
    "genetic-perturbation",
    "sex",
    "age-group",
    "developmental-stage",
    "environment",
    "assay-modality",
    "assay-target",
    "variant-origin",
    "sample-pairing",
    "processing-level",
    "assay-version",
    "batch",
    "replicate",
    "tool-variant",
    "library-prep",
    "data-partition",
    "other",
] as const;
export type DimensionCategory = (typeof DIMENSION_CATEGORY_IDS)[number];

export type DimensionScope = "biological" | "technical";

/**
 * What the substrate test says for this category by default. `split` means one value's
 * files are typically a different substrate to a downstream step, so the set is split
 * into groups; `dimension` means the values are variants of one substrate and stay a
 * slot, possibly bound to a dimension.
 */
export type DimensionTreatment = "split" | "dimension";

export interface DimensionCategoryEntry {
    readonly id: DimensionCategory;
    readonly scope: DimensionScope;
    readonly definition: string;
    readonly defaultTreatment: DimensionTreatment;
    /** Why the default reads the way it does, and the nearest neighbour it is not. */
    readonly note: string;
}

export const DIMENSION_CATEGORIES: readonly DimensionCategoryEntry[] = [
    {
        id: "subject",
        scope: "biological",
        definition: "The individual the data is about — patient, animal, donor. For a xenograft the subject is the donor; the host is genotype context.",
        defaultTreatment: "dimension",
        note: "Never split. Not the specimen — see sample.",
    },
    {
        id: "sample",
        scope: "biological",
        definition: "Physical specimen. Nests under subject where one exists; community and environmental samples have none.",
        defaultTreatment: "dimension",
        note: "Never split. Not the library or aliquot, which is technical — see library-prep.",
    },
    {
        id: "organism-species",
        scope: "biological",
        definition: "Species, when it varies across the dataset.",
        defaultTreatment: "split",
        note: "Species picks the reference genome. A constant organism is an identity field, not a dimension.",
    },
    {
        id: "model-system",
        scope: "biological",
        definition: "Cell line, organoid, or model identity in subject-less panels.",
        defaultTreatment: "dimension",
        note: "A line used as the subject surrogate is still model-system, not subject.",
    },
    {
        id: "cohort-arm",
        scope: "biological",
        definition: "Grouping assigned by design — randomisation, dose groups, discovery/validation cohorts. Assigned-by-design is the sole test.",
        defaultTreatment: "dimension",
        note: "Comparative models consume all arms together. Split only for independent cohorts, as a stated deviation. Observed conditions are disease-state.",
    },
    {
        id: "disease-state",
        scope: "biological",
        definition: "Observed diagnosis or condition varying across subjects, including observational case/control.",
        defaultTreatment: "dimension",
        note: "Assigned-by-design grouping is cohort-arm.",
    },
    {
        id: "treatment",
        scope: "biological",
        definition: "Compound, dose, or intervention as the varying quantity, including protocol-administered diet.",
        defaultTreatment: "dimension",
        note: "Dose-response curves are consumed together. Named designed groups are cohort-arm; ambient exposure is environment.",
    },
    {
        id: "timepoint",
        scope: "biological",
        definition: "When the measurement was taken, in subject or visit time.",
        defaultTreatment: "dimension",
        note: "Known-ambiguous and documented as such. Acquisition, run, and processing dates are batch; duration of exposure is treatment.",
    },
    {
        id: "tissue-site",
        scope: "biological",
        definition: "Organism part, sampling site, biofluid, or subcellular fraction, when it varies.",
        defaultTreatment: "dimension",
        note: "Ambiguous like timepoint. A constant tissue is an identity field.",
    },
    {
        id: "cell-type",
        scope: "biological",
        definition: "Sorted population or annotated type, when it varies across files.",
        defaultTreatment: "dimension",
        note: "Per-cell annotations inside one matrix are file content, not a dimension.",
    },
    {
        id: "genetic-perturbation",
        scope: "biological",
        definition: "Strain, genetic modification, KO/WT, CRISPR guide, shRNA, or ORF per member.",
        defaultTreatment: "dimension",
        note: "Perturbation as the study's designed comparison is cohort-arm.",
    },
    { id: "sex", scope: "biological", definition: "Sex as a varying attribute.", defaultTreatment: "dimension", note: "A constant is an identity field." },
    {
        id: "age-group",
        scope: "biological",
        definition: "Age or age band as a varying attribute.",
        defaultTreatment: "dimension",
        note: "Calendar age; biology is developmental-stage.",
    },
    {
        id: "developmental-stage",
        scope: "biological",
        definition: "Developmental stage as a varying attribute.",
        defaultTreatment: "dimension",
        note: "Age-group is calendar; stage is biology.",
    },
    {
        id: "environment",
        scope: "biological",
        definition: "Diet, stimulus, growth condition, field location.",
        defaultTreatment: "dimension",
        note: "Administered per protocol is treatment; plot or block structure is batch.",
    },
    {
        id: "assay-modality",
        scope: "technical",
        definition: "Which measurement technology — RNA-seq vs proteomics vs imaging.",
        defaultTreatment: "split",
        note: "Different substrates. Different-marker panels are a different modality or target, not a version; a version of one assay is assay-version.",
    },
    {
        id: "assay-target",
        scope: "technical",
        definition: "The molecular target an assay is directed at — a ChIP antibody target, a panel's target set.",
        defaultTreatment: "split",
        note: "Each target's output is a distinct substrate. Modality is the technology; target is what it points at.",
    },
    {
        id: "variant-origin",
        scope: "technical",
        definition: "Somatic vs germline.",
        defaultTreatment: "split",
        note: "The canonical substrate case.",
    },
    {
        id: "sample-pairing",
        scope: "technical",
        definition: "Tumour/normal or matched-pair membership.",
        defaultTreatment: "split",
        note: "Split with the pair id kept on both halves, because paired callers consume both together. Pairing is within-subject; cohort-arm is between-subjects.",
    },
    {
        id: "processing-level",
        scope: "technical",
        definition: "Raw, filtered, and normalised tiers of the same product.",
        defaultTreatment: "split",
        note: "Steps consume one tier. Alternate tools at the same tier are tool-variant.",
    },
    {
        id: "assay-version",
        scope: "technical",
        definition: "Panel, kit, or pipeline version over the same target set.",
        defaultTreatment: "dimension",
        note: "Batch-like. Different marker sets are assay-modality or assay-target.",
    },
    {
        id: "batch",
        scope: "technical",
        definition: "Plate, lane, centre, run or acquisition date.",
        defaultTreatment: "dimension",
        note: "Never split. Subject-visit time is timepoint.",
    },
    {
        id: "replicate",
        scope: "technical",
        definition: "Replicate index. The label must state whether the replication is biological or technical.",
        defaultTreatment: "dimension",
        note: "Never split.",
    },
    {
        id: "tool-variant",
        scope: "technical",
        definition: "Alternate callers or aligners over the same input.",
        defaultTreatment: "dimension",
        note: "Consumed together for consensus. Pipeline versions over time are assay-version.",
    },
    {
        id: "library-prep",
        scope: "technical",
        definition: "Library, label, capture, or aliquot.",
        defaultTreatment: "dimension",
        note: "A biofluid or subcellular fraction is biological — tissue-site.",
    },
    {
        id: "data-partition",
        scope: "technical",
        definition: "Chromosome shard, file chunk, read-pair half, paged export.",
        defaultTreatment: "dimension",
        note: "Never split, rarely promoted — pure mechanics that stays on the set.",
    },
    {
        id: "other",
        scope: "technical",
        definition: "Outside the catalogue — carry a free label saying what varies.",
        defaultTreatment: "dimension",
        note: "Monitored: a wrong specific category is worse than an honest `other`.",
    },
];

// ── Probe list ─────────────────────────────────────────────────────────────

export const DIMENSION_PROBE_IDS = ["subject", "sample", "cohort-arm", "timepoint", "batch"] as const;
export type DimensionProbe = (typeof DIMENSION_PROBE_IDS)[number];

/**
 * A probe outcome, exactly one per probe.
 *
 * `not-found` is a correct and complete answer once the searched set is named — that is
 * what removes the completeness pressure that otherwise invents dimensions. `attested`
 * records prose-only evidence and can never justify a split.
 */
export const PROBE_OUTCOME_IDS = ["found", "not-found", "found-but-constant", "attested"] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOME_IDS)[number];

export interface DimensionProbeEntry {
    readonly id: DimensionProbe;
    /** Where a `found` typically comes from. */
    readonly guidance: string;
}

/**
 * The only dimensions the agent actively looks for. The searchable set is bounded and
 * named: files in metadata- or documentation-role groups plus clinical-table and
 * sample-annotation members, up to about ten files. Everything off this list is recorded
 * only when encountered during ordinary orientation reading.
 *
 * Assay-modality and replicate are deliberately absent: varying modality is already
 * surfaced by group categories, and probing for replicates invites inferring replicate
 * structure from sample counts, which is fabrication by another name.
 */
export const DIMENSION_PROBES: readonly DimensionProbeEntry[] = [
    {
        id: "subject",
        guidance:
            "Identifier slots in per-subject trees; subject-ID columns in clinical or sample tables. A reference-only tree is a legitimate not-found — a genome build's species is not a subject.",
    },
    { id: "sample", guidance: "Sample-ID slots or columns; sample sheets. Nests under subject when both exist." },
    {
        id: "cohort-arm",
        guidance:
            "Arm or group columns whose values are assigned by design. An observed condition or diagnosis column is disease-state — answer not-found and point to where it landed. Observational data typically has no arms.",
    },
    { id: "timepoint", guidance: "Visit, day, or cycle columns; timepoint tokens in names. Acquisition and run dates are batch." },
    { id: "batch", guidance: "Plate, lane, or run columns; run-date tokens; centre identifiers. Subject-visit time is timepoint." },
];

// ── Lookups ────────────────────────────────────────────────────────────────

const GROUP_CATEGORY_BY_ID = new Map(GROUP_CATEGORIES.map((entry) => [entry.id, entry]));
const DIMENSION_CATEGORY_BY_ID = new Map(DIMENSION_CATEGORIES.map((entry) => [entry.id, entry]));

export function groupCategoryEntry(id: GroupCategory): GroupCategoryEntry {
    return GROUP_CATEGORY_BY_ID.get(id)!;
}

export function dimensionCategoryEntry(id: DimensionCategory): DimensionCategoryEntry {
    return DIMENSION_CATEGORY_BY_ID.get(id)!;
}

/**
 * The scope a dimension takes.
 *
 * Derived from the category for everything in the catalogue. `other` is by definition
 * outside it, so there is nothing to derive from and the scope is the agent's to declare:
 * a biological thing that varies and has no category is still biological, and pinning
 * every `other` to technical would misfile it. Undeclared, it defaults to technical.
 */
export function dimensionScope(id: DimensionCategory, declared?: DimensionScope): DimensionScope {
    if (id === "other") return declared ?? "technical";
    return DIMENSION_CATEGORY_BY_ID.get(id)?.scope ?? "technical";
}

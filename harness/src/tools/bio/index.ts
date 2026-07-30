/**
 * Bio barrel — pure external-API bioinformatics & cheminformatics lookups.
 *
 * Leaf tools with no harness dependencies: each wraps one or more external data
 * sources (Ensembl, ChEMBL, PubChem, Open Targets, PubMed, EPA CompTox, …)
 * behind a `defineTool`. Grouped here so the conversation agent imports one
 * barrel rather than a file per tool.
 *
 * The boundary is the QUESTION, not the database. Where several corpora answer
 * the same question, the corpus is a `sources` parameter and the tool fans out
 * (`gene_disease_evidence`, `drug_gene_interactions`, `target_safety`,
 * `lookup_annotation`, `gene_preclinical_profile`); where one database answers
 * several questions, the endpoint is an `action` parameter (`chembl`,
 * `pubchem`, `pubmed`, `comptox`, `opentargets`, `search_interactions`).
 *
 * Every tool returns a BOUNDED result by default. A default call is sized to be
 * read, not to be complete: limits are small, verbose fields are opt-in, and
 * each result carries the true totals (`totalFound`, `totalInteractions`,
 * `tissueCount`, `outline`, …) so a caller can tell a trimmed answer from a
 * sparse one and widen deliberately.
 */

// Identifier resolution
export * from "./search-gene.js";

// Functional annotation / networks
export * from "./lookup-annotation.js";
export * from "./search-interactions.js";

// Literature
export * from "./pubmed.js";

// Cheminformatics
export * from "./chembl.js";
export * from "./pubchem.js";

// Target assessment
export * from "./opentargets.js";
export * from "./gene-disease-evidence.js";
export * from "./drug-gene-interactions.js";
export * from "./gene-preclinical-profile.js";

// Clinical / public-data landscape
export * from "./search-clinical-trials.js";
export * from "./search-geo-datasets.js";
export * from "./search-faers.js";

// Safety / toxicology
export * from "./target-safety.js";
export * from "./comptox.js";

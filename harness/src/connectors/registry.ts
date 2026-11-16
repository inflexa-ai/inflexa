/**
 * The connectors: each shipped tool that reaches an outside service belongs to exactly one connector. A user attaches
 * connectors to agents, never single tools. The registry is closed: a host gives the settings of a connector, and it
 * cannot define one.
 */

import type { CitationResolver } from "../citations/types.js";
import type { Logger } from "../lib/logger.js";
import type { ToolOutputStore } from "../loop/tool-output.js";
import {
    alphafoldPredictionTool,
    chemblTool,
    genePreclinicalProfileTool,
    getProteinDomainsTool,
    getVariantFrequenciesTool,
    humanbaseTool,
    lookupAnnotationTool,
    openTargetsTool,
    pubchemTool,
    resolveGeneIdsTool,
    searchClinicalTrialsTool,
    searchFaersTool,
    searchGeneTool,
    searchGeoDatasetsTool,
    searchInteractionsTool,
    searchProteinTool,
    targetSafetyTool,
} from "../tools/bio/index.js";
import { createComptoxTool } from "../tools/bio/comptox.js";
import { createDrugGeneInteractionsTool } from "../tools/bio/drug-gene-interactions.js";
import { createGeneDiseaseEvidenceTool } from "../tools/bio/gene-disease-evidence.js";
import { createPubMedTool } from "../tools/bio/pubmed.js";
import { createSearchPatentsTool } from "../tools/bio/search-patents.js";
import { createSearchRegulatoryApprovalsTool } from "../tools/bio/search-regulatory-approvals.js";
import type { Tool } from "../tools/define-tool.js";
import { queryDocsTool, resolveLibraryIdTool } from "../tools/research/context7-docs.js";
import { createResolveCitationTool } from "../tools/research/resolve-citation.js";
import { searchArxivTool } from "../tools/research/search-arxiv.js";
import { createSearchGithubReposTool } from "../tools/research/search-github-repos.js";
import { createSearchSemanticScholarTool } from "../tools/research/search-semantic-scholar.js";
import { createSearxngEngine } from "../tools/research/searxng-engine.js";
import { createWebFetchTool } from "../tools/research/web-fetch.js";
import { createWebSearchTool, type WebSearchEngine } from "../tools/research/web-search.js";

/** One credential slot of a connector. */
export type CredentialSlot = {
    /** A required slot makes each call of the tool fail without a value. An optional slot lowers a limit or opens a source. */
    readonly required: boolean;
    /** The source inside the tool that the slot opens, when the tool queries more than one source. */
    readonly unlocks?: string;
};

/** What a connector reads when an agent that attaches it is built. */
export type ConnectorContext = {
    /** The value of a credential slot, already read from the catalog. */
    readonly credential: (slot: string) => string | undefined;
    /** The endpoint of the connector: the override of the host, else the default of the connector. */
    readonly endpoint: string | undefined;
    readonly logger?: Logger;
    /** The shared bibliographic verification service. Absent, the citation connector gives no tool. */
    readonly citationResolver?: CitationResolver;
    readonly toolOutputStore?: ToolOutputStore;
    /** The web-search engine of the host. An endpoint of the connector replaces it. */
    readonly webSearch?: WebSearchEngine;
};

export type ConnectorDefinition = {
    readonly id: string;
    readonly description: string;
    /** The outside service that the planner reads as a live lookup, or `null` for a service that holds no data. */
    readonly liveSource: string | null;
    readonly credentials: Readonly<Record<string, CredentialSlot>>;
    /** A connector with an endpoint lets the host point it at another instance. */
    readonly defaultEndpoint?: string;
    /** The tools of the connector. An empty list is a normal state, for example a connector with no engine. */
    readonly tools: (ctx: ConnectorContext) => readonly Tool[];
};

export function defineConnector(definition: ConnectorDefinition): ConnectorDefinition {
    return definition;
}

const optional: CredentialSlot = { required: false };
const required: CredentialSlot = { required: true };

/**
 * The knowledge connector is a gate: the knowledge tools of the planner need the client of the host and the hooks of
 * the planner, thus the planner builds them itself when it attaches this connector. A template step gets its tool from
 * the step, not from a connector.
 */
export const KNOWLEDGE_CONNECTOR_ID = "knowledge";

const CONNECTOR_LIST: readonly ConnectorDefinition[] = [
    defineConnector({
        id: "pubmed",
        description: "PubMed literature: search, article details and full text.",
        liveSource: "PubMed",
        credentials: { ncbi: optional },
        tools: (ctx) => [createPubMedTool({ ncbiApiKey: ctx.credential("ncbi") })],
    }),
    defineConnector({
        id: "citations",
        description: "Verification of one citation against Crossref, PubMed, arXiv and Semantic Scholar.",
        liveSource: "Crossref, PubMed, arXiv, and Semantic Scholar",
        credentials: {},
        tools: (ctx) => (ctx.citationResolver === undefined ? [] : [createResolveCitationTool(ctx.citationResolver)]),
    }),
    defineConnector({
        id: "semantic-scholar",
        description: "Semantic Scholar: papers and the citation graph across fields.",
        liveSource: "Semantic Scholar",
        credentials: { "semantic-scholar": optional },
        tools: (ctx) => [createSearchSemanticScholarTool({ apiKey: ctx.credential("semantic-scholar") })],
    }),
    defineConnector({
        id: "arxiv",
        description: "arXiv preprints.",
        liveSource: "arXiv",
        credentials: {},
        tools: () => [searchArxivTool],
    }),
    defineConnector({
        id: "github",
        description: "GitHub repository search for published pipelines and code.",
        liveSource: "GitHub",
        credentials: { github: optional },
        tools: (ctx) => [createSearchGithubReposTool({ githubToken: ctx.credential("github") })],
    }),
    defineConnector({
        id: "context7",
        description: "Context7: the documentation of a software library.",
        liveSource: null,
        credentials: {},
        tools: () => [resolveLibraryIdTool, queryDocsTool],
    }),
    defineConnector({
        id: "web-search",
        description: "Web search through a SearXNG instance.",
        liveSource: null,
        credentials: {},
        tools: (ctx) => {
            const engine = ctx.endpoint === undefined ? ctx.webSearch : createSearxngEngine({ baseUrl: ctx.endpoint });
            return engine === undefined ? [] : [createWebSearchTool({ engine })];
        },
    }),
    defineConnector({
        id: "web-fetch",
        description: "A guarded fetch of one public web page.",
        liveSource: null,
        credentials: {},
        tools: (ctx) => [createWebFetchTool({ toolOutputStore: ctx.toolOutputStore })],
    }),
    defineConnector({
        id: KNOWLEDGE_CONNECTOR_ID,
        description: "The Inflexa knowledge plane: tested procedures and script templates.",
        liveSource: null,
        credentials: {},
        tools: () => [],
    }),
    defineConnector({
        id: "gene-search",
        description: "Gene identifiers from Ensembl and NCBI Gene.",
        liveSource: "Ensembl and NCBI Gene",
        credentials: {},
        tools: () => [searchGeneTool],
    }),
    defineConnector({
        id: "protein-search",
        description: "UniProt protein entries.",
        liveSource: "UniProt",
        credentials: {},
        tools: () => [searchProteinTool],
    }),
    defineConnector({
        id: "mygene",
        description: "MyGene.info: the mapping across the symbol, Entrez, Ensembl and UniProt identifier spaces.",
        liveSource: "MyGene.info",
        credentials: {},
        tools: () => [resolveGeneIdsTool],
    }),
    defineConnector({
        id: "annotations",
        description: "Functional annotation from GO, KEGG and Reactome.",
        liveSource: "GO, KEGG, and Reactome annotation",
        credentials: {},
        tools: () => [lookupAnnotationTool],
    }),
    defineConnector({
        id: "string",
        description: "STRING protein interaction networks and enrichment.",
        liveSource: "STRING",
        credentials: {},
        tools: () => [searchInteractionsTool],
    }),
    defineConnector({
        id: "humanbase",
        description: "HumanBase tissue- and process-specific functional networks.",
        liveSource: "HumanBase tissue networks",
        credentials: {},
        tools: () => [humanbaseTool],
    }),
    defineConnector({
        id: "alphafold",
        description: "AlphaFold DB structure predictions.",
        liveSource: "AlphaFold DB",
        credentials: {},
        tools: () => [alphafoldPredictionTool],
    }),
    defineConnector({
        id: "interpro",
        description: "InterPro domains of a protein, with their residue ranges.",
        liveSource: "InterPro",
        credentials: {},
        tools: () => [getProteinDomainsTool],
    }),
    defineConnector({
        id: "gnomad",
        description: "gnomAD population allele frequencies of short variants.",
        liveSource: "gnomAD",
        credentials: {},
        tools: () => [getVariantFrequenciesTool],
    }),
    defineConnector({
        id: "geo",
        description: "NCBI GEO gene-expression datasets.",
        liveSource: "GEO",
        credentials: {},
        tools: () => [searchGeoDatasetsTool],
    }),
    defineConnector({
        id: "chembl",
        description: "ChEMBL compounds, mechanisms, bioactivity and targets.",
        liveSource: "ChEMBL",
        credentials: {},
        tools: () => [chemblTool],
    }),
    defineConnector({
        id: "pubchem",
        description: "PubChem compounds, cross-references and assays.",
        liveSource: "PubChem",
        credentials: {},
        tools: () => [pubchemTool],
    }),
    defineConnector({
        id: "opentargets",
        description: "Open Targets target assessment.",
        liveSource: "Open Targets",
        credentials: {},
        tools: () => [openTargetsTool],
    }),
    defineConnector({
        id: "target-safety",
        description: "Target-level safety: a curated panel and the liabilities of Open Targets.",
        liveSource: "a curated target safety panel",
        credentials: {},
        tools: () => [targetSafetyTool],
    }),
    defineConnector({
        id: "preclinical",
        description: "Bgee baseline expression and IMPC mouse knockouts.",
        liveSource: "Bgee expression and IMPC knockouts",
        credentials: {},
        tools: () => [genePreclinicalProfileTool],
    }),
    defineConnector({
        id: "faers",
        description: "FDA adverse event reports (FAERS).",
        liveSource: "FAERS",
        credentials: {},
        tools: () => [searchFaersTool],
    }),
    defineConnector({
        id: "clinical-trials",
        description: "ClinicalTrials.gov studies.",
        liveSource: "ClinicalTrials.gov",
        credentials: {},
        tools: () => [searchClinicalTrialsTool],
    }),
    defineConnector({
        id: "gene-disease-evidence",
        description: "Gene–disease evidence from the GWAS Catalog, DisGeNET, ClinVar and cBioPortal.",
        liveSource: "GWAS Catalog, DisGeNET, and ClinVar",
        credentials: { disgenet: { required: false, unlocks: "DisGeNET" }, ncbi: optional },
        tools: (ctx) => [
            createGeneDiseaseEvidenceTool({ disgenetApiKey: ctx.credential("disgenet") ?? "", ncbiApiKey: ctx.credential("ncbi"), logger: ctx.logger }),
        ],
    }),
    defineConnector({
        id: "drug-gene-interactions",
        description: "Drug–gene interactions from DGIdb, DrugBank and PharmGKB.",
        liveSource: "DGIdb, DrugBank, and PharmGKB",
        credentials: { drugbank: { required: false, unlocks: "DrugBank" } },
        tools: (ctx) => [createDrugGeneInteractionsTool({ drugbankApiKey: ctx.credential("drugbank") ?? "", logger: ctx.logger })],
    }),
    defineConnector({
        id: "comptox",
        description: "EPA CompTox toxicology, hazard, chemical and exposure data.",
        liveSource: "EPA CompTox",
        credentials: { "epa-ccte": required },
        tools: (ctx) => [createComptoxTool({ apiKey: ctx.credential("epa-ccte") ?? "" })],
    }),
    defineConnector({
        id: "regulatory-approvals",
        description: "FDA and EMA authorizations with their label text (Amass).",
        liveSource: "FDA and EMA approvals",
        credentials: { amass: required },
        tools: (ctx) => [createSearchRegulatoryApprovalsTool({ apiKey: ctx.credential("amass") ?? "" })],
    }),
    defineConnector({
        id: "patents",
        description: "Patents (Amass).",
        liveSource: null,
        credentials: { amass: required },
        tools: (ctx) => [createSearchPatentsTool({ apiKey: ctx.credential("amass") ?? "" })],
    }),
];

/** Each connector of the harness, by id. */
export const CONNECTORS: ReadonlyMap<string, ConnectorDefinition> = new Map(CONNECTOR_LIST.map((connector) => [connector.id, connector]));

/** The connector ids that a host can attach, in a stable order. */
export const CONNECTOR_IDS: readonly string[] = CONNECTOR_LIST.map((connector) => connector.id);

/** The connectors that a host can show: the id, the description, and the credential slots of each. */
export function describeConnectors(): readonly Pick<ConnectorDefinition, "id" | "description" | "credentials" | "defaultEndpoint">[] {
    return CONNECTOR_LIST.map(({ id, description, credentials, defaultEndpoint }) => ({ id, description, credentials, defaultEndpoint }));
}

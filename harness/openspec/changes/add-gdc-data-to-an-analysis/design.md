## Context

An analysis cannot get public data today. These facts set the design:

- The sandbox denies egress. `search_geo_datasets` tells the agent that it
  gives metadata only (`src/tools/bio/search-geo-datasets.ts:98`).
- No harness tool writes network bytes to a disk. `apiFetch` reads the whole
  body into memory, with a timeout of 90 s (`src/tools/lib/api-utils.ts:147`).
- The only download path is the CLI command `inflexa geo download`. It
  records no provenance, and the user adds the files as an input later
  (`cli/openspec/specs/geo-input-download/spec.md`).
- `ctx.ask` refuses in a workflow step. The conversation agent can ask
  (`src/tools/approval/contract.ts:88`).
- The conversation agent gets its seams through `ConversationAgentDeps`, for
  example `runLauncher` (`src/agents/conversation-agent.ts:112-207`). The
  embedder adds its host tools last (`src/agents/conversation-agent.ts:375`).
- The reference-data catalog is the precedent for a split between the harness
  and the embedder. The harness publishes a plan, and each embedder installs
  it (spec `reference-data-catalog`).
- The planner holds read-only search tools (`src/tools/research/generate-plan.ts:911`).
  Its prompt names each tool, and when to use it (`src/prompts/planner.ts:80-96`).
  If a necessary reference is absent, the planner stops with
  `request_clarification` (`src/prompts/planner.ts:158`).

A live probe of the GDC API on 2026-09-26 gave these facts:

- The API reports `Data Release 46.0 - August 10, 2026` at `/status`.
- The GDC holds 93 projects in 27 programs. TCGA has 33 projects.
- TCGA-BRCA has 1,231 open STAR gene-count files, 5.2 GB in total. The sample
  types are 1,111 Primary Tumor, 113 Solid Tissue Normal, and 7 Metastatic.
- The filter `analysis.workflow_type = STAR - Counts` alone matches 2,462
  files. The other 1,231 files are controlled splice-junction files.
- One `POST /files` query with `size` 5,000 returned all 1,231 rows on one
  page.
- `/files` with `format=tsv` flattens the nested fields, for example
  `cases.0.samples.0.sample_type`.
- One TCGA-BRCA case has no `demographic` block. Thus a clinical field can be
  absent.

## Goals / Non-Goals

**Goals:**

- The agent can find what the GDC holds for a cohort, in the conversation and
  in the planner.
- The user approves one download, and the files arrive as one input, with the
  origin recorded.
- One seam serves each embedder, and it serves a later source too.
- The harness moves the GDC bytes as the GDC gives them.

**Non-Goals:**

- Controlled-access data.
- A download from a step or from the planner.
- A merge, a normalization, or a survival calculation in the harness.
- A progress display during the transfer.
- A GEO source.
- Skill content for TCGA.

## Decisions

### Two tools for two audiences

`search_gdc_data` is read-only, and it needs no seam. The conversation agent
and the planner hold it. `download_gdc_data` moves bytes, and only the
conversation agent holds it, when the embedder gives the seam.

This design rejects one tool with a mode. The planner must never download,
and the tool set of an agent is the control for that rule. The sandbox
specialists do not get the search tool in this change. A specialist cannot
act on the answer in the middle of a step.

### The harness plans, and the embedder transfers

The seam and its values go into the root barrel, because the embedder writes
the seam:

```ts
export interface InputAcquirer {
    /** The largest plan, in declared bytes, that this embedder accepts. */
    readonly maxBytes: number;
    acquire(plan: AcquisitionPlan, options: AcquireOptions): Promise<Result<AcquiredInput, AcquisitionError>>;
}

export interface AcquireOptions {
    /** The session of the tool call. The embedder finds the analysis from its scope. */
    readonly session: AgentSession;
    readonly signal: AbortSignal;
}

export interface AcquiredInput {
    /** The input path, as the embedder records it. */
    readonly path: string;
    readonly fileCount: number;
    readonly bytes: number;
}

export type AcquisitionError =
    | { readonly type: "too_large"; readonly bytes: number; readonly maxBytes: number }
    | { readonly type: "destination_exists"; readonly name: string }
    | { readonly type: "digest_mismatch"; readonly path: string }
    | { readonly type: "transfer_failed"; readonly path: string; readonly detail: string }
    | { readonly type: "refused"; readonly reason: string }
    | { readonly type: "aborted" };
```

`ConversationAgentDeps` gains the optional field `inputAcquirer`. The field
flows through `ConversationAssemblyDeps` with no other change
(`src/runtime/assemble.ts:110-113`).

The embedder owns the disk layout, the input rows, and the provenance
recorder. The CLI also has a downloader with a liveness watch and retries.
This design rejects two alternatives:

- The harness downloads into a directory that the embedder names. Then the
  harness needs a write path outside the workspace. A managed host with object
  storage cannot give a directory.
- A CLI command, as `inflexa geo download` is. That command records no
  provenance, and the capability then exists under one host only.

### The plan contract

```ts
export interface AcquisitionPlan {
    readonly source: { readonly name: string; readonly baseUrl: string; readonly release: string };
    /** The request, in the form that the source defines. For GDC, the canonical JSON of the query. */
    readonly request: string;
    /** One safe path segment. The embedder names the input directory with it. */
    readonly name: string;
    readonly items: readonly AcquisitionItem[];
}

export interface AcquisitionItem {
    /** A safe path, relative to the input directory. */
    readonly path: string;
    /** An https URL. */
    readonly url: string;
    readonly size?: number;
    readonly digest?: { readonly algorithm: "md5"; readonly value: string };
    /** The identifier that the source gives, or the URL when the source gives none. */
    readonly sourceId: string;
}
```

A zod schema validates a plan before the tool asks for approval. An item path
obeys the rule of `ReferenceArtifactPathSchema` (`src/reference-data/catalog.ts:13`).
The two schemas share that rule. The schema also refuses these plans:

- a URL that is not https
- two items with the same path
- a name that is not one safe path segment
- a plan with no item

The digest algorithm is `md5` only. The GDC publishes md5, and a second
algorithm waits for a second source.

### The GDC plan

The request of `download_gdc_data` is:

```ts
{
    projects: string[];                // one or more GDC project ids, for example "TCGA-BRCA"
    files?: { dataType: string; workflowType?: string; sampleTypes?: string[] };
    clinical: boolean;
}
```

A request must name `files`, or set `clinical`, or do both. The builder makes
the plan in these steps:

1. It reads the release from `/status`.
2. It makes the file filter: the projects, the data type, the workflow type,
   the sample types, and `access = open`.
3. It reads the file rows with `POST /files`, in pages of 5,000.
4. It adds one item for each file. The path is `{file_id}/{file_name}`, which
   is the layout of the GDC Data Transfer Tool. The URL is
   `{baseUrl}/data/{file_id}`. The size and the md5 come from the row.
5. It adds a `sample-sheet.tsv` item. The item is a `GET /files` query with
   `format=tsv` and the fields of the file, the case, and the sample. Thus
   the case barcode, the sample barcode, and the sample type of each file
   come from the GDC.
6. If `clinical` is true, it adds a `clinical.json` item. The item is a
   `GET /cases` query for the projects, with the demographic, the diagnoses,
   the treatments, the exposures, and the `follow_ups` records.
7. It sets the name from the projects, the data type, and the major release,
   for example `gdc-tcga-brca-gene-expression-quantification-r46`.

The two query items have no digest, and their `sourceId` is the URL. Their
`size` query value is the count from the plan. Thus one request gets each row.

The `request` text is the canonical JSON of the file filter and the clinical
flag. The builder also counts the files that match with no access filter. If
no open file matches, but a controlled file matches, the tool reports that
fact.

### The tool flow

```
download_gdc_data(request)
  ├─ make the plan
  │    ├─ no file and no clinical records   → ok { kind: "nothing_matched" }
  │    └─ controlled files only             → ok { kind: "controlled_only", controlledFileCount }
  ├─ declared bytes > inputAcquirer.maxBytes → ok { kind: "too_large", bytes, maxBytes }
  ├─ ctx.ask({ title, command, detail })     → a denial throws AskRejectedError
  ├─ inputAcquirer.acquire(plan, { session, signal })
  │    ├─ ok  → ok { kind: "downloaded", input, fileCount, bytes, release }
  │    └─ err → ok { kind: "failed", error }
```

An expected outcome is an `ok` variant, under the error contract of
`harness-tools`. The loop maps a denial to its denial result.

The ask has no `grantKey`. An `always` grant then keys on the exact command.
Each download moves gigabytes, and a family grant lets the agent download a
different cohort without a question.

The `command` of the ask names the file count, the size, and the release. It
also names the projects, the data type, the workflow type, the sample types,
and the clinical flag. `detail` stays under `DETAIL_MAX_LENGTH`.

The tool keeps the default execution mode. In the conversation, `runStep` is
a pass-through, thus no DBOS row exists. If the process stops, the call is
lost, and the embedder deletes its partial files.

### The search tool

`search_gdc_data` takes these optional filters: the projects, the program,
the primary site, the data category, the data type, the workflow type, the
experimental strategy, and the sample types. It gives these values:

- the release
- the projects, when the request names no project, with the name, the
  primary site, and the case count, to a maximum of 50
- the file count and the case count
- the facet counts for the data category, the data type, the workflow type,
  the experimental strategy, the sample type, and the access level
- the vital-status counts of the cases, when the request names a project

One `/files` query with `size=0` gives the facets. One `/cases` query with
`size=0` gives the vital status. An empty result is a normal result.

The description uses the same rule as `search_geo_datasets`. It states that the tool gives metadata only, and that the sandbox has no
network. It does not name the download tool, because the planner holds the
search tool and not the download tool.

### The planner

`buildPlannerSearchTools` adds `search_gdc_data`. The "Search when" list of
the planner prompt gets one item. If the question needs data that the inputs
do not hold, and the cohort is a GDC cohort, the planner uses
`search_gdc_data`. If the GDC holds the data, the planner calls
`request_clarification`, and it names the data and the GDC project. The
planner never plans a step that downloads.

The conversation prompt does not change. Its rule "Report an environment gap
as permanent without checking" (`src/prompts/conversation.ts:370`) already
sends the agent to its tools, and the tool describes itself. A prompt line
that names `download_gdc_data` is wrong under an embedder with no seam.

### The client and its evidence

`src/tools/lib/gdc-client.ts` uses `apiFetchValidated`, with POST and a JSON
body for `/files`. Each zod schema obeys `bio-api-schema-fidelity`. Each field
is optional where the GDC omits it. The golden tier of
`integration-tests-external-api` gets real payloads of `/status`, a `/files`
facet query, a `/files` row query, and a `/cases` facet query.

## Risks / Trade-offs

- [The GDC publishes a new release between the plan and the transfer] → The
  embedder downloads by UUID. A file that the GDC removed fails the transfer,
  and the CLI adds no input. The receipt keeps the release of the plan.
- [A download takes some minutes, and the chat shows no progress] → The first
  version accepts this. Refer to the open question.
- [The TCGA barcode join is the frequent error] → The sample sheet gives the
  case barcode, the sample barcode, and the sample type of each file. The
  skill content is a separate change.
- [The clinical JSON is nested, and its fields differ between programs] → The
  harness writes it as the GDC gives it. A step flattens it with code that the
  provenance records.
- [A plan is larger than the ceiling of the embedder] → The tool reports
  `too_large` before it asks.
- [The query items have no digest] → The embedder records their SHA-256
  hash. The receipt keeps their URL.

## Migration Plan

No stored data changes. An embedder with no seam keeps its tool set, and it
gets `search_gdc_data` only. The harness and the kernel can publish in any
sequence. The CLI release comes after the two.

## Open Questions

- Must the tool stream its progress to the chat? That is a `data-*` part and
  a renderer in the CLI.

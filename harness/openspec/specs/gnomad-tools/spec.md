# gnomad-tools Specification

## Purpose

Defines the harness tool `get_variant_frequencies`, which reads the GraphQL API
of gnomAD (`https://gnomad.broadinstitute.org/api`). gnomAD, the Genome
Aggregation Database, gives the allele frequencies of short variants in large
human cohorts, as [Chen and others, Nature 2024](https://www.nature.com/articles/s41586-023-06045-0)
describe. A population allele frequency is the primary filter in rare-variant
interpretation. The reference store cannot stage gnomAD, and the sandbox has no
network access. Thus this tool is the path to a population frequency.

The API is GraphQL, and its errors do not obey the contract of a REST API.
gnomAD answers a miss with HTTP 200, a `null` variant, and an `errors` entry
"Variant not found". gnomAD keeps only the message of an error, thus an error
has no `path`. Thus the client ties a miss to its variant through the `null`
field of that variant. Each other error message stops the call.

The tool takes a batch of variants, not one variant. gnomAD limits each IP
address to 30 requests and to a query cost of 300 in one minute. One query can
cost at most 25, and one `variant` field costs 1. Thus one request carries at
most 25 variants, and the client sends one gnomAD request at a time. A script
that gets the frequencies of a list of candidate variants then sends one
request, not one request for each variant.

The tool is a `defineTool` wrapper over the gnomAD client
(`harness/src/tools/lib/gnomad-client.ts`). The client uses the shared
`apiFetchValidated` boundary. A miss is a data variant. `execute` throws an
unexpected failure, and the agent loop records it as
`tool_result { is_error: true }`. The tool never returns a `{ success, error }`
envelope.

## Requirements

### Requirement: The get_variant_frequencies tool gives the frequencies of a batch

The system MUST give one harness tool, `getVariantFrequenciesTool`
(`harness/src/tools/bio/get-variant-frequencies.ts`), with the on-wire id
`get_variant_frequencies`, built with `defineTool`. The input is `variantIds`, 1
to 25 variant IDs, and `dataset`, a dataset of gnomAD with the default
`gnomad_r4`. The tool MUST return `ok({ dataset, referenceGenome, variants, notFound })`.

Each record in `variants` carries `query`, `variantId`, `rsids`, `genome`, and
`exome`. `query` is the ID of the request that the record answers, and
`variantId` is the ID that gnomAD normalized. `genome` and `exome` each carry
`ac`, `an`, `af`, and `populations`. Each callset is `null` when the dataset
has no such callset.

The client MUST trim each ID, and it MUST send a duplicate ID one time. The
client MUST send the batch in one request, with one GraphQL alias for each
variant.

#### Scenario: A found variant gives the two callsets

- **WHEN** the tool is called with `variantIds: ["1-55051215-G-GA"]`
- **THEN** the record carries `rsids: ["rs527413419"]`, a `genome` with an `af` of 0.0047727, and an `exome` with an `af` of 0.0006317

#### Scenario: The batch goes in one request

- **WHEN** the tool is called with `[" 1-55051215-G-GA ", "1-55051215-G-GA", "1-1-A-T"]`
- **THEN** the client posts one body with the aliases `v0` and `v1`, and the variables hold each ID one time

### Requirement: The input takes only a variant ID that gnomAD can parse

The input schema MUST refuse a variant ID that is not in the form
chrom-pos-ref-alt. The chromosome MUST be 1 to 22, X, or Y. The position MUST be
a positive integer, and each allele MUST hold only A, C, G, and T. The schema
MUST accept a `chr` prefix, lowercase letters, and `:` in place of `-`, because
gnomAD accepts them.

This form is stricter than the parser of gnomAD. Thus a valid input never gets
"Invalid variant ID", and each `null` alias is a miss. gnomAD serves a
mitochondrial variant through a different query field, thus the schema refuses
the chromosome M.

#### Scenario: A malformed ID is refused

- **WHEN** the tool is called with `rs527413419` or `M-1-A-G`
- **THEN** the input validation refuses the call, and `execute` does not run

#### Scenario: An ID with a chr prefix and colons is accepted

- **WHEN** the tool is called with `chr1:55051215:g:ga`
- **THEN** the input validation accepts the call

### Requirement: The dataset fixes the reference genome

The `dataset` input MUST take each value of the `DatasetId` enum of gnomAD, and
the tool MUST give the `referenceGenome` of the dataset. The `gnomad_r4` and
`gnomad_r3` datasets use GRCh38. The `gnomad_r2_1` datasets and `exac` use
GRCh37. A variant ID on the other genome comes back in `notFound`, not as an
error. Thus the description of the tool MUST tell the agent to match the
coordinates to the dataset.

#### Scenario: A GRCh37 dataset

- **WHEN** the tool is called with `dataset: "exac"`
- **THEN** `referenceGenome` is `GRCh37`, and the `genome` of each record is `null`, because ExAC holds exomes only

### Requirement: A miss is a data variant

The tool MUST list each variant ID that the dataset does not hold in `notFound`,
and it MUST NOT drop the miss. The tool MUST NOT return an error for a miss.

#### Scenario: A partial batch reports its misses

- **WHEN** the batch holds `1-55051215-G-GA` and `1-1-A-T`
- **THEN** `variants` holds the record of `1-55051215-G-GA`, and `notFound` is `["1-1-A-T"]`

#### Scenario: No variant is found

- **WHEN** no variant of the batch is in the dataset
- **THEN** the tool returns `ok({ dataset, referenceGenome, variants: [], notFound })`, not an error

### Requirement: An unexpected failure is an error tool result

`execute` MUST throw an HTTP error, a timeout, an exhausted retry, and a payload
that the schema refuses. `execute` MUST also throw when an `errors` entry is not
"Variant not found", and a miss in the same answer does not change that. A rate
limit answers HTTP 400 with a message, and the error text MUST hold that
message.

#### Scenario: The rate limit is an error

- **WHEN** gnomAD answers HTTP 400 with `Query rate limit exceeded. Please try again in a few minutes.`
- **THEN** `execute` throws, and the error text holds that message

#### Scenario: A different error beside a miss

- **WHEN** the `errors` of an answer hold "Variant not found" and "Invalid variant ID"
- **THEN** `execute` throws with "Invalid variant ID"

#### Scenario: A server error surfaces as an error tool result

- **WHEN** gnomAD answers with a 5xx
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: The client sends one gnomAD request at a time

The client MUST send each gnomAD request through the host limit `gnomad` of
`harness/src/lib/host-concurrency.ts`, with a limit of 1. Thus a script that
calls the tool in parallel with `Promise.all` sends one request at a time. The
description of the tool MUST tell the agent to put the variants of one dataset
into one call.

#### Scenario: A script calls the tool in parallel

- **WHEN** one script calls the tool three times with `Promise.all`
- **THEN** gnomAD gets one request at a time, and the script gets each result

### Requirement: The client obeys the absence policy of GraphQL

The client schema MUST mark each nullable field of the gnomAD schema as
`.nullable()`, because a GraphQL server sends an explicit `null`. A comment at
the top of the client MUST name that policy. The nullable fields are `rsids`,
`genome`, `exome`, the `ac`, `an`, and `af` of a callset, and the population
list.

#### Scenario: An ExAC variant parses

- **WHEN** a variant has `genome: null` and `rsids: []`
- **THEN** the mapped record has `genome: null` and `rsids: []`

### Requirement: The populations are the top-level ancestry groups

The client MUST keep only the top-level genetic ancestry groups of a callset,
each with `id`, `ac`, `an`, and `af`. gnomAD also gives each group split by sex,
and the cohorts of 1000 Genomes and HGDP. The client MUST drop those rows,
because a default result must stay small (refer to the header of
`harness/src/tools/bio/index.ts`). gnomAD gives no `af` for a group. Thus the
client calculates `ac / an`, and it gives `null` when `an` is 0.

#### Scenario: The groups of a gnomad_r4 genome callset

- **WHEN** the genome callset of a gnomad_r4 variant holds the groups split by sex and the 1000 Genomes and HGDP cohorts
- **THEN** `populations` holds only the 10 groups `remaining`, `amr`, `fin`, `ami`, `eas`, `mid`, `sas`, `asj`, `afr`, and `nfe`

#### Scenario: A group with no called allele

- **WHEN** a group has `an: 0`
- **THEN** its `af` is `null`

### Requirement: The tool declares the type of its ok value

The tool MUST declare the schema of its ok value. Thus the catalog of
`run_script` shows the result type in the signature of the tool.

#### Scenario: The catalog shows the result type

- **WHEN** the catalog of `run_script` is built over the tool
- **THEN** the signature of `get_variant_frequencies` shows its result type, not `unknown`

#### Scenario: A script reads the frequencies

- **WHEN** one script calls the tool with a found variant and a miss, and no `dataset`
- **THEN** the script reads the `af` of the found variant in `gnomad_r4`, and it reads the miss in `notFound`

### Requirement: The call detail names the dataset and the variants

The `describeCall` hook MUST give the dataset and at most 3 variant IDs. For a
batch of more than 3 IDs, the detail MUST give the count and the first 3 IDs.

#### Scenario: The detail of a large batch

- **WHEN** the tool is called with 5 IDs, `1-1-A-T` to `1-5-A-T`, and `dataset: "gnomad_r2_1"`
- **THEN** the call detail is `gnomad_r2_1: 5 variants: 1-1-A-T, 1-2-A-T, 1-3-A-T, …`

### Requirement: The conversation agent and the genomic variant agent get the tool

The conversation agent MUST have `get_variant_frequencies` as a script tool, thus
it calls the tool from `run_script` (refer to the script-tools capability).

`SandboxToolName` MUST have `getVariantFrequencies`, and the sandbox registry
MUST map that name to the tool. The genomic variant agent MUST list
`getVariantFrequencies` in `meta.tools`, because variant filtering is one of its
capabilities.

#### Scenario: The conversation agent has the tool in a script

- **WHEN** the conversation agent is made
- **THEN** its script tools include `get_variant_frequencies`, and its tools do not

#### Scenario: Only the genomic variant agent gets the tool

- **WHEN** each sandbox agent is made
- **THEN** only the genomic variant agent has `get_variant_frequencies`, and it has the tool as a script tool

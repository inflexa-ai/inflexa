# Spec Delta

## Purpose

Defines script tools: the tools that an agent calls from one JavaScript script through the `run_script` tool, and that no request declares. It holds the declaration on the agent, the tool that the loop adds, and the script API. It also holds the isolation, the limits, the result, and the durable step of a script, the file tools and the scratch directory of a script, its provenance, its display, its metrics, and the script tools of the conversation agent.

## ADDED Requirements

### Requirement: An agent declares its script tools, and the loop adds run_script

`AgentDefinition` MUST have the optional field `scriptTools`. At the open of each conversation, the loop MUST add the tool `run_script` after each tool of an agent that has script tools. A request MUST declare `run_script`, and it MUST NOT declare a script tool. An agent with no script tools, or with an empty list, MUST get no `run_script`, and its tools MUST NOT change.

#### Scenario: run_script comes after the tools of the agent

- **GIVEN** an agent with the tool `pubmed` and the script tool `search_gene`
- **WHEN** the loop opens a conversation of the agent
- **THEN** the tools of the conversation are `pubmed` and `run_script`, in that order

#### Scenario: An agent with no script tools stays as it is

- **WHEN** the loop opens a conversation of an agent with no script tools, or with an empty list
- **THEN** the agent has no `run_script`, and its tools do not change

#### Scenario: A request declares run_script and no script tool

- **GIVEN** an agent with the tool `search_gene` and the script tool `pubmed`
- **WHEN** the loop sends the first request of a run
- **THEN** the request declares `search_gene` and `run_script`, and it does not declare `pubmed`

### Requirement: A script tool asks no approval and starts no workflow

A script runs as one tool call. Thus no surface can ask the user about a nested call, and a nested call cannot start a child workflow. The loop MUST throw at the open of a conversation when a script tool of the agent has an approval hook or starts a workflow. The error MUST name the tool and the agent. A step that did not complete runs its whole script again, thus a script tool that writes MUST accept the same write again.

#### Scenario: A script tool with an approval hook

- **GIVEN** an agent `a` with the script tool `write_note`, which has an approval hook
- **WHEN** the loop opens a conversation of the agent
- **THEN** the loop throws `the script tool write_note of agent a asks an approval or starts a workflow`

### Requirement: A tool that is its own durable step is no script tool

A script is one durable step, and each nested call runs inside it. A tool whose call must be its own step, for example an exec whose id comes from its step, MUST declare it. The loop MUST throw at the open of a conversation when a script tool of the agent declares it. The error MUST name the tool and the agent.

#### Scenario: An exec tool as a script tool

- **GIVEN** an agent `a` with the script tool `execute_command`, which is its own step
- **WHEN** the loop opens a conversation of the agent
- **THEN** the loop throws `the script tool execute_command of agent a must run as its own durable step`

### Requirement: The catalog gives the result type of a script tool

A tool MAY declare the schema of its ok value. The value MUST then hold each field of the schema. The catalog of `run_script` MUST show the result type of such a tool in its signature, and `unknown` for a tool with no schema or with a type too long for the catalog. `describe` MUST give the full type.

#### Scenario: A typed tool in the catalog

- **GIVEN** a script tool `count_genes` whose ok value is `{ count: number }`
- **WHEN** the loop builds `run_script`
- **THEN** the catalog holds `count_genes(args: { set: string; }): Promise<{ count: number; }>;`

### Requirement: The description of run_script is the script API and a catalog of the script tools

The description of `run_script` MUST give the script API, and then one catalog line for each script tool: the id of the tool and the first sentence of its description. The rest of the description of a script tool MUST stay out of it. The description MUST be a function of the script tools only. Thus each request of a conversation declares the same `run_script`, and the prompt cache of the provider holds.

#### Scenario: The catalog holds the first sentence only

- **GIVEN** the script tool `search_gene`, with the description "Resolve gene identifiers against Ensembl. Batch up to 200 identifiers.", and the script tool `pubmed`
- **WHEN** `run_script` is built over the two tools
- **THEN** its description holds `- search_gene: Resolve gene identifiers against Ensembl.` and `- pubmed: Search PubMed.`
- **AND** it does not hold `Batch up to 200 identifiers.`

### Requirement: A script calls a script tool as a function

In a script, `await tools.<name>(args)` MUST parse `args` with the input schema of the tool. Then it MUST run the `execute` of the tool with the context of the `run_script` call, and give the JSON of the ok value. A script MUST be able to run calls at the same time with `Promise.all`.

#### Scenario: Parallel calls

- **WHEN** a script calls `search_gene` and `pubmed` in one `Promise.all`, prints the gene symbols, and returns the PMIDs that it keeps
- **THEN** the result is `ok: true`, with the printed line as `output` and the kept PMIDs as `value`
- **AND** `calls` holds `search_gene` and `pubmed`, each with `ok: true`

### Requirement: A failed nested call is an Error that the script can catch

When the input schema of the tool refuses a call, the call MUST throw a JavaScript `Error` that names the tool and the field. The tool MUST NOT run. A call whose tool gives an error MUST throw an `Error` whose message is the id of the tool and the text of the error. A script MUST be able to catch each such `Error`. `calls` MUST hold each failed call with `ok: false`.

#### Scenario: A failed call is an Error that the script catches

- **GIVEN** a `pubmed` call whose tool gives the error "PubMed is unavailable"
- **WHEN** the script catches the error and prints its message
- **THEN** the output is `caught: pubmed: PubMed is unavailable`, and `calls` holds `pubmed` with `ok: false`

#### Scenario: An input that the schema refuses

- **WHEN** a script calls `search_gene` with an empty `identifiers` list, and does not catch the error
- **THEN** the result is `ok: false`, its error holds `search_gene: identifiers:`, and `calls` holds `search_gene` with `ok: false`

### Requirement: describe gives the full description of a script tool

In a script, `await describe("<name>")` MUST give the full description and the input type of the script tool with that id. A name that is not the id of a script tool MUST throw an `Error` that lists the ids of the script tools.

#### Scenario: The description and the input type of one tool

- **WHEN** a script returns `await describe("search_gene")`
- **THEN** the value holds `Batch up to 200 identifiers.` and `identifiers: Array<string>`

### Requirement: Only what a script prints and returns reaches the model

The result of `run_script` MUST be an ok result with the fields `ok`, `output`, `value`, `error`, `calls`, `script`, and `files`. `output` is the printed text, in order. `value` is the JSON of the returned value. `calls` lists each tool call, in order, with the tool id and `ok`. `script` is the path of the saved script, and `files` lists each derived file. A nested result MUST NOT reach the model apart from what the script prints or returns.

#### Scenario: The value reaches the next request

- **GIVEN** a model that calls `run_script` with a script that returns the `totalFound` of a `pubmed` call, which is 3
- **WHEN** the loop sends the next request
- **THEN** the request holds the result with `"value":3`
- **AND** the recorded call of `run_script` holds `calls` with `pubmed` and `ok: true`

### Requirement: A failed script gives an ok result

A script that fails MUST give an ok result with `ok: false` and no `value`. Its `error` MUST give the kind and the message of the failure. Thus the model reads the output and the calls before the failure.

#### Scenario: An uncaught error ends the script

- **WHEN** a script throws `new Error("no answer")`
- **THEN** the result is `ok: false`, and its error holds `no answer`

### Requirement: The printed output of a script is bounded

When the printed text of a script is longer than 24,000 characters, `output` MUST keep its first and its last 12,000 characters. A line between the two MUST give the count of the characters that it cut. The bound applies to `output` only.

#### Scenario: A long output keeps its head and its tail

- **WHEN** a script prints 30,000 characters
- **THEN** `output` holds the first and the last 12,000 characters, with the line `[... 6000 characters cut ...]` between them

### Requirement: A script runs in an isolated VM with a deadline and a heap limit

A script MUST run in a QuickJS VM in a worker thread, with no files, no network, no timers, and no modules. Its only capabilities are the calls of its script tools and of `describe`, thus a file tool is its only way to a file. One script MUST end at 180 seconds. The heap of the VM MUST stop at 256 MiB, which holds a table of the read cap as rows. A cancel of the `run_script` call MUST reach the signal of each nested call.

#### Scenario: A script past its deadline

- **WHEN** a script runs for more than 180 seconds
- **THEN** the script ends, and the result is `ok: false` with an error of the kind `timeout`

### Requirement: A script is one durable step

Inside a workflow, a `run_script` call MUST be one durable step of the loop, the same as each other tool that starts no workflow. A nested call MUST NOT be a step of its own. A replay MUST give the result of the script from its checkpoint, and it MUST NOT run a nested call again. A step that did not complete runs the whole script again on recovery.

#### Scenario: A replay runs no lookup again

- **GIVEN** a chat turn whose loop completed a `run_script` call that called `pubmed`, and then stopped
- **WHEN** the turn recovers
- **THEN** the `run_script` call gives its result from its checkpoint, and `pubmed` does not run

### Requirement: The conversation agent calls its lookups from a script

`createConversationAgent` MUST give each lookup, and `read_table`, `write_derived`, and `render_chart`, as script tools, and it MUST NOT declare one as a tool of the agent. A lookup is a read-only API call, for example an identifier, the literature, a compound, or a target.

#### Scenario: The lookups are script tools only

- **WHEN** the conversation agent is built
- **THEN** its script tools include `read_table`, `write_derived`, `render_chart`, `search_gene`, `pubmed`, `resolve_citation`, `chembl`, and `web_fetch`
- **AND** its tools include none of its script tools
- **AND** no script tool has an approval hook or starts a workflow

#### Scenario: Citation verification follows PubMed

- **WHEN** the conversation agent is built
- **THEN** `resolve_citation` comes directly after `pubmed` in its script tools

### Requirement: A script reads a table through read_table

`read_table` MUST read one table through the read seam of the workspace, thus a path outside the analysis and a symbolic link are refused. It MUST read CSV, TSV, a JSON array of flat objects, and parquet, up to 16 MiB. It MUST give each row as an object keyed by column. A plain decimal number MUST read as a number, and a cell with a leading zero MUST stay text. A larger table and a format with no parser MUST be an error that names an analysis run.

#### Scenario: A table with a numeric column and an identifier

- **GIVEN** a CSV with the rows `TP53,0.001,007` and `FLT3,0.2,12` under the header `gene,padj,id`
- **WHEN** a script reads it
- **THEN** the rows are `{ gene: "TP53", padj: 0.001, id: "007" }` and `{ gene: "FLT3", padj: 0.2, id: 12 }`

#### Scenario: A table over the cap

- **WHEN** a script reads a CSV of more than 16 MiB
- **THEN** the call throws an Error that names the cap and an analysis run

### Requirement: A script writes only derived files of its session

`write_derived` and `render_chart` MUST write only into `derived/` of the scratch directory of the session, under one file name with no directory. A name MUST hold one file for the life of the session: the same bytes again pass with no write, and other bytes are refused. A derived file MUST hold at most 16 MiB, and one session at most 256 MiB. `write_derived` MUST write text, or rows as CSV, TSV, or JSON by the extension of the name.

#### Scenario: Other bytes under a name are refused

- **GIVEN** a derived file `notes.md` with the text `one`
- **WHEN** a script writes `notes.md` with the text `two`
- **THEN** the call throws an Error that says that the session holds a different `notes.md`, and the file keeps `one`

#### Scenario: Rows as CSV

- **WHEN** a script writes the rows `{ gene: "TP53", note: "a, b" }` and `{ gene: "FLT3", note: null }` as `top.csv`
- **THEN** the file holds `gene,note`, `TP53,"a, b"`, and `FLT3,`

### Requirement: render_chart writes an SVG file for a document

`render_chart` MUST render an ECharts option, the option that `show_user` takes, to an SVG file at a journal column width. It MUST refuse a chart of more than 10,000 points.

#### Scenario: A bar chart at the double column

- **WHEN** a script renders a bar chart as `bars`
- **THEN** `derived/bars.svg` holds an SVG with the width `183mm`

### Requirement: A script reads a PDF with no sandbox

`read_pdf` MUST give the text of the asked pages of a PDF of the workspace, and the page count of the document, through the read path of the workspace. One call MUST read at most 50 pages, and a file over 64 MiB MUST be refused. It MUST run in the process of the host, with no container.

#### Scenario: Pages of a long PDF

- **WHEN** a script reads pages 2 to 3 of a PDF of three pages
- **THEN** the result holds the text of pages 2 and 3, and the page count 3

### Requirement: Each agent that reads the workspace reads a PDF

The conversation agent, the report agent, each sandbox step agent, and the data profiler MUST hold `read_pdf` as a script tool. A paper of an analysis is a PDF, and each of these agents can need it.

#### Scenario: A step agent reads a paper

- **GIVEN** a sandbox step agent of any type
- **WHEN** its tools are resolved
- **THEN** its script tools hold `read_pdf`

### Requirement: A script makes a PDF with no sandbox and no browser

`export_pdf` MUST make a PDF from markdown in the derived directory of the session, in the process of the host, with no container and no browser. An image of the markdown MUST be a file of the workspace that the tool reads, and the PDF MUST read no URL and no other file.

#### Scenario: A chart in a PDF

- **GIVEN** a script that wrote `volcano.svg` with `render_chart`
- **WHEN** it calls `export_pdf` with markdown that names that path as an image
- **THEN** the derived directory holds the PDF with the chart, and the record of the call holds the read of the chart and the write of the PDF

#### Scenario: An image that the workspace does not hold

- **WHEN** the markdown names an image that is no readable file of the workspace
- **THEN** the PDF shows its alt text, and the result names the image in `missingImages`

### Requirement: A session keeps each script

With a scratch directory, `run_script` MUST save the code of each script before it runs, at `scripts/{invocationId}.js` under the scratch directory of the session. A failed script MUST stay saved. The scratch directory of a conversation is `conversation-sessions/{threadId}/`. A scope with no thread MUST save no script.

#### Scenario: A script is saved before it runs

- **WHEN** a conversation runs a script in the call `toolu_1`
- **THEN** `conversation-sessions/{threadId}/scripts/toolu_1.js` holds the code, and the result names that path as `script`

### Requirement: The files of a script reach provenance

Each file tool MUST give the files that it read or wrote, with the hash of the exact bytes, as the call record of its nested call. `run_script` MUST collect these records into its own call record. Its fold MUST emit one `run-script` session event with the saved script, the reads, the writes, the tools, and `ok`. A script that read and wrote no file MUST emit nothing. The fold of `run_script` MUST also give the record of each nested call to the fold of its tool, in the order of the calls.

#### Scenario: A derived file chains to the table that it came from

- **WHEN** a script reads `runs/r1/s1/output/de.csv` and writes `top.csv`, and the call record folds
- **THEN** the seam receives one `run-script` event with the script, the read of `de.csv`, and the write of `top.csv`

### Requirement: A nested call shows while the script runs

Each nested call MUST emit `tool-started` and `tool-finished` frames, with the detail of the nested tool. The source of the frames MUST be one level below the `run_script` call: the agent id `run_script`, the call path of the caller with `run_script` appended, and the invocation id of the `run_script` call. Thus a surface puts each nested call on the activity line of the `run_script` call. A `run_script` call of the root agent MUST also emit the `data-subagent-activity` part of its nested calls.

#### Scenario: A table read shows under the script

- **WHEN** a script reads `runs/r1/s1/output/de.csv` in the call `toolu_1`
- **THEN** the turn receives a `tool-started` frame of `read_table` with the detail of the path and the invocation id `toolu_1`, and a `tool-finished` frame with the detail `3 rows`

### Requirement: The derived files of a script show in one card

When a script derives a file, `run_script` MUST emit one `data-file-reference` card with each derived file and the saved script. The title of the card MUST be the description of the call when it has one.

#### Scenario: One card for the files and the script

- **WHEN** a script with the description "Significant genes" writes `top.csv`
- **THEN** the turn receives one file card with the title "Significant genes", `top.csv`, and the saved script

### Requirement: run_script names its call

The input of `run_script` MUST carry an optional one-line `description`. The detail of the call MUST be the description. The detail of the result MUST be the description and the tools that the script called.

#### Scenario: The description names the call

- **WHEN** the agent runs a script with the description "Significant genes" that reads one table
- **THEN** the detail of the call is "Significant genes", and the detail of the result is "Significant genes (read_table)"

### Requirement: The metrics of the scripts show when a script outgrows the VM

`run_script` MUST count each script by its failure: none, a script error, an exhausted heap, a timeout, an abort, or a fault of the VM. `read_table` MUST count each refused read by its reason, and it MUST record the bytes of each read. A replay MUST count nothing, because it runs no body.

#### Scenario: A table over the cap counts

- **WHEN** a script reads a table of more than 16 MiB
- **THEN** the counter of refused reads grows by one with the reason `too_large`

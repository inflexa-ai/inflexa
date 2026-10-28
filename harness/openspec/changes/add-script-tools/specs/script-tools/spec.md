# Spec Delta

## Purpose

Defines script tools: the tools that an agent calls from one JavaScript script through the `run_script` tool, and that no request declares. It holds the declaration on the agent, the tool that the loop adds, and the script API. It also holds the isolation, the limits, the result, and the durable step of a script, and the lookups of the conversation agent.

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

A script runs as one tool call. Thus no surface can ask the user about a nested call, and a nested call cannot start a child workflow. The loop MUST throw at the open of a conversation when a script tool of the agent has an approval hook or starts a workflow. The error MUST name the tool and the agent.

#### Scenario: A script tool with an approval hook

- **GIVEN** an agent `a` with the script tool `write_note`, which has an approval hook
- **WHEN** the loop opens a conversation of the agent
- **THEN** the loop throws `the script tool write_note of agent a asks an approval or starts a workflow`

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

The result of `run_script` MUST be an ok result with the fields `ok`, `output`, `value`, `error`, and `calls`. `output` is the text that the script printed, in order. `value` is the JSON of the returned value, and it is absent when the script returned nothing. `calls` lists each tool call of the script, in the order of the calls, with the id of the tool and `ok`. A nested result MUST NOT reach the model apart from what the script prints or returns.

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

A script MUST run in a QuickJS VM in a worker thread. The VM MUST give the script no files, no network, no timers, and no modules. The only capabilities of a script are the calls of its script tools and of `describe`. One script MUST end at 180 seconds, for each call in it together. The heap of the VM MUST stop at 128 MiB. A cancel of the `run_script` call MUST also reach the signal of each nested call.

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

`createConversationAgent` MUST give each lookup as a script tool, and it MUST NOT declare a lookup as a tool of the agent. A lookup is a read-only API call: an identifier, an annotation, a structure, the literature, the web, a compound, a target, the clinical and regulatory record, or an expression or safety profile. The conversation prompt MUST tell the agent to run its lookups in `run_script`, with independent lookups in one script.

#### Scenario: The lookups are script tools only

- **WHEN** the conversation agent is built
- **THEN** its script tools include `search_gene`, `pubmed`, `resolve_citation`, `chembl`, and `web_fetch`
- **AND** its tools include none of its script tools
- **AND** no script tool has an approval hook or starts a workflow

#### Scenario: Citation verification follows PubMed

- **WHEN** the conversation agent is built
- **THEN** `resolve_citation` comes directly after `pubmed` in its script tools

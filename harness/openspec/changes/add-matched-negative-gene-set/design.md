## Context

The issue [#677](https://github.com/inflexa-ai/inflexa/issues/677) gives the method, the catalog entries, and the harness changes. The user made two decisions before this change. The feature stays out of the knowledge plane and lives in the open-source harness. The system supports both negative definitions, `annotation_free` and `tested_clean`, with the pros and the cons stated.

The review of 2026-10-18 added the decisions below. It read each upstream URL, the term ids, the HPO license page, the receipt logic of the installer, and the tool set of the planner.

The current state:

- The catalog holds GTEx v8 and STRING v12.0. The STRING entry has the links file and the info file, but not the aliases file. Thus a join from STRING to GTEx goes through the symbol, and a renamed gene drops out in silence.
- The catalog holds no phenotype source. The reference store cannot say which gene has a liver annotation and which gene passed a liver screen.
- The `translational-safety` pack has one reference, `pharmacovigilance.md`. The agent advertises no gene-list input and no matching capability.
- The package store holds pandas, pyarrow, scipy, scikit-learn, and igraph (`images/package-store/manifest.yaml`). Thus the sandbox can read the parquet files, compute the betweenness, and fit the logistic model.
- The installer compares the receipt of a dataset to the catalog by the artifact count and the artifact paths (`cli/src/modules/refs/store.ts:614`). A dataset that fails the comparison at the same version is an `invalid_receipt`, and the installer fetches each artifact again (`store.ts:1125`).
- The planner has no skill tool (`harness/src/tools/research/generate-plan.ts:1099`). It knows an agent through its capability phrases, and it knows the store through the reference census of its seed.

The constraints come from the root `CLAUDE.md`, "Agent-facing content". A skill names a dataset by what it is, never by a path or a tool. A prompt names a tool, never a dataset. A tool describes itself.

## Goals / Non-Goals

**Goals:**

- One run makes the matched negative gene set with the evidence columns and the signed record.
- Each negative has a label that the run can defend. Each other choice is a parameter with a reported count.
- The method is tissue-agnostic content in the skill pack. The liver is the worked example.
- The planner routes a gene-list request about tissue risk to the translational-safety agent, and it can ask for an absent source before the run.
- A request without a definition gives a clarification or two sets, never one set with a silent choice.

**Non-Goals:**

- No new harness tool. The step runs igraph and pandas in the sandbox.
- No change to the knowledge plane, or to the prompt of the translational-safety agent. The planner prompt takes one routing rule.
- No change to the schema of the catalog, to the receipt logic, or to the install path of an embedder.
- No catalog entry for DILImap. It is a positive source of the customer, not an exclusion dataset.
- No acknowledgement of the HPO in the product. The HPO license asks for one, and that is a separate issue.

## Decisions

### The method is a skill reference, not a tool and not a prompt

The method lives in `skills/translational-safety/references/matched-negative-gene-set.md`. A tool would hard-code the liver, the thresholds, and the file layout. The prompt of the agent is a cached constant, and it must not name a dataset. The skill is the layer that holds the work. The agent finds the files through the reference inventory, by description, and the catalog `contents` text makes each file findable.

The alternative is a dedicated harness tool with the matching inside. It is rejected, because the step is a data analysis, and the sandbox is the place for a data analysis.

### The translational-safety agent owns the task

The exclusion sources are phenotype and safety data. The agent already holds `targetSafety` and `genePreclinicalProfile`, and its pack holds the hepatotoxicity content. The network metrics are a means, not the question. Thus the `network-agent` is not the owner, and the `enrichment-agent` is not the owner.

The `gene-lists` input class now matches two agents. The planner selects by the capability phrases and by one routing rule. The first phrase names the task, the three data classes, and the two definitions. The second phrase, "expression and PPI connectivity matching", names the method. No capability phrase holds a comma, because each renderer joins the phrases with a comma.

### The capability phrase names the data classes, and an absent source stops the negatives file

The planner cannot read a skill. Thus it cannot know that the method needs the phenotype sources, and it cannot ask for them. The capability phrase carries that knowledge: "matched negative gene set for a tissue risk benchmark (annotation_free or tested_clean negatives) matched on tissue expression and PPI connectivity with mouse and human phenotype annotation exclusions". The phrase spells each definition as the skill spells it, because `skill_search` matches a substring. The planner matches the data classes against the reference census of its seed. Its existing rule on an absent reference gives the `request_clarification`.

A step cannot ask, and a run can start before the sources are installed. Then the step writes the resolution, the universe table, and the audit with the sources that it has. It writes no negatives file, and its summary names the absent source. A negatives file with a wrong label is worse than none.

The `annotation_free` label means that these four exclusion sources were applied: the mouse phenotypes, the human phenotypes, the safety events, and the viability calls. The viability calls count only when `exclude_lethal` is on. The `tested_clean` definition also needs the IMPC completeness file. A definition whose source is absent gets no set, and the other definition still runs.

Two sources outside the exclusion step have their own rule. The alias table is necessary for each definition, because the network metrics need the Ensembl join. Without it the step computes no metrics and writes no negatives file. The homology reports are necessary for a mouse symbol, and without them each mouse-only symbol is `unresolved`.

The alternative is to write the set with a column that lists the sources applied. It is rejected, because a customer reads the file, not the column.

### The two definitions reach the planner through the capability phrase

The planner reads the capability phrases from the agent catalog. Thus the two definitions are visible to it, and its existing rule on an essential fact covers the question. The rule is in `src/prompts/planner.ts`: `request_clarification` if a specific fact about the data is essential. The `clarification_needed` outcome reaches the user through the conversation agent.

The planner prompt takes one routing rule, because its existing rule sends each gene-list step to the enrichment agent (`src/prompts/planner.ts:217`). A capability phrase alone cannot overrule a hard rule of the prompt. The new rule says that the question of a gene-list step selects the agent, and it names the safety route for a matched negative set.

A step cannot ask. Thus the reference tells the step to make both sets when the briefing names no definition, each with its own diagnostics. The report then gives the pros and the cons of each set, and a recommendation.

### A gene with an unknown liver label is not a negative

A homozygous lethal knockout has no liver phenotype because nobody phenotyped it. Its liver label is unknown, and an unknown label in the negative set is noise. The viability table of IMPC gives the call. The rule excludes a `lethal` gene from both tiers under the parameter `exclude_lethal`, which is on by default. A `subviable` call is a value of the `viability` column, not an exclusion. The report gives the count that the rule excluded, and the lethal share of the positives.

The cost is a smaller pool of hubs, because a lethal gene is often a hub. The matching then reports a shortfall in the high-degree cells. A reported shortfall is better than label noise. The customer can turn the parameter off and compare the two balance reports.

The viability table holds a call per colony, not per gene. One gene can carry a lethal call and a viable call on two colonies, and 14 genes do. Thus a lethal call takes precedence over a subviable and over a viable call of the same gene. The table calls an X-linked knockout hemizygous, thus the tier rule counts a hemizygous colony as a full knockout. The report gives the count of each tier, and a count of zero is not the expected result.

The alternative is to keep the lethal genes and to flag them. It is rejected as the default, because a flag in a column does not stop a classifier from a wrong label.

### The matching balances the joint distribution

The cells are joint: 10 deciles of the log expression by 5 quintiles of the log degree by 5 quintiles of the log betweenness, cut on the positives. The quota of a cell is the target count times the share of the positives in the cell. A short cell takes the nearest candidates in the standardized space, marked `nearest`. Marginal bins are rejected, because the degree and the betweenness correlate, and a marginal match leaves the joint distribution separable.

A universe gene with no STRING protein in the alias table gets the flag `in_string` false. A gene with a protein and no edge in the subgraph keeps the flag true. Both keep degree 0 and betweenness 0, and both stay in the pool. Absence from STRING is a learnable feature, thus both classes must carry it in proportion. A dropped gene biases the negatives toward the connected genes.

The flag is not the degree. A left merge against the vertex list of the induced subgraph gives a null degree to each gene with no surviving edge. Thus a flag that comes from the degree reports an isolated gene as an absent gene.

A positive of the `mouse_class` route leaves the matching, because it has no one human gene. Every human gene of its class is excluded from the pool, because one of them is the positive.

### The human Ensembl gene id comes from the gene table

The human gene table of NCBI carries the Ensembl gene id in its `dbXrefs` column. The resolution writes that id into `positives_resolved.csv`, and each later join uses it. GTEx carries a versioned id, and the join strips the version. A human gene without an Ensembl cross-reference is `resolved`, but it is outside the universe, and the report counts it.

### The diagnostics measure the residual

The balance report gives the SMD, the KS statistic, and the p-value per matched covariate. The three matched covariates are `log_tpm`, `log_degree`, and `log_betweenness`, which are the base-10 logarithm of the value plus 1. The report also gives one AUC of a logistic model on those three covariates.

The count of GO gene sets per gene comes from the MSigDB GO collection. It is a reported residual with its own field and its own SMD, and it is not a matched covariate and not a KS row. It measures the con of the issue: a model can learn studied against unstudied. The MSigDB GO collection is a recommended dataset. If it is absent, the report says that the diagnostic was not computed.

The cross-validation needs a positive and a negative in each of the 5 folds. With fewer than 5 genes in a class, the report gives a null AUC and the reason. A NaN value in the file breaks each JSON reader.

### The IMPC clinical chemistry procedure is a prefix

The IMPC procedure id has versions, `IMPC_CBC_001` and later. The tested rule matches the prefix `IMPC_CBC_` in the successful procedures of a colony, with the four parameters successful. The file writes each parameter in full, for example `Alanine aminotransferase` and `Total bilirubin`. A test for the abbreviation matches no row. The prefix and the four names belong to the liver, thus another tissue replaces them with its own panel.

### The upstream identifiers and the free text carry traps

The review of the pull request measured each filter against the live files. Four traps change the result:

- The mouse gene table writes the MGI id with the prefix two times, for example `MGI:MGI:87854`. The homology reports and the mouse screens write it one time. A direct join gives no match.
- The tissue id of a safety event carries two spellings, `UBERON_0002107` on 74 rows and `UBERON:0002107` on 6 rows. The event text is mixed case. One spelling with an exact-case match finds 57 of the 88 targets that carry a liver liability.
- The top-level class column of the IMPC assertions holds a comma-separated list on 13,643 of 67,350 rows. An equality test finds 322 genes of the liver class, and a membership test finds 351.
- The `resource_name` column of the same file holds `IMPC`, `EuroPhenome`, `MGP`, `3i`, and `pwg`. An upper-case form matches no row.

The reference names each trap at the step that meets it. The `contents` text of each entry names it too, because another consumer reads that text and not the skill.

### The STRING aliases file is a companion dataset

The aliases file is the dataset `string-aliases-human`, at the version 12.0, in the group `interaction-networks`, opt-in. It is not an artifact of `string-ppi-human`. A third artifact at the same version makes each existing STRING install an `invalid_receipt` (`cli/src/modules/refs/store.ts:614`), and the installer then fetches all three files again (`store.ts:1125`). The inventory loses the catalog labels of the STRING files until that happens. The companion obeys the precedent of `reactome-mappings` beside `reactome-pathways`. The aliases file gives one Ensembl gene id per STRING protein id under the source `Ensembl_gene`, and the join to GTEx goes through that id.

The receipt holds the version and the artifact paths only (`store.ts:615`). Thus the `contents` text of `string-ppi-human` can change with no effect on an install, and each entry now names the other.

### The catalog entries are opt-in, and they take their places by group

The six datasets are `recommended: false`. Four of them form the new group `phenotype-annotations`. The MGI homology reports join the group `gene-identifiers`, and the STRING aliases join the group `interaction-networks`. The reference store becomes about 100 MB larger, and a default setup must not download a domain-specific set.

The entries take their places by group in `catalog.ts`. The MGI entry goes after `uniprot-idmapping-rat`. The STRING aliases go after `string-ppi-human`. The four phenotype entries go after `hpa-proteinatlas`, because they describe a gene in a tissue. The ordered id list of `catalog.test.ts` changes at those three positions.

The alternative is to add the six at the end of the catalog, as the cisTarget entries were. It is rejected, because a reader finds a mapping table beside the mapping tables.

### The organism field

`impc-phenotyping` is mouse. `hpo-annotations`, `opentargets-target-safety-event`, and `string-aliases-human` are human. `opentargets-mouse-phenotype` keys mouse phenotypes on human Ensembl ids, and `mgi-mouse-human-homology` holds two species in one table. Those two declare no organism, as `omnipath-interactions` does. The test set `organismAgnostic` gets the two ids.

### The version of the MGI reports is `current`

MGI rebuilds the reports weekly, and no release directory exists. The entry uses the version `current`, as `reactome-pathways` and `omnipath-interactions` do. The install receipt records the bytes that the install received, thus `verify` works without a checked-in digest.

### The HPO license

The HPO license page gives three conditions and no identifier. The conditions are: cite the HPO Consortium, show the version of each HPO file in a public display, and do not change the files. The identifier is `LicenseRef-HPO`, with the URL of the page, as `omnipath-interactions` uses a `LicenseRef-` form. The catalog comment carries the three conditions. Inflexa fetches the files from the upstream and does not change them. The acknowledgement in the product is a separate issue.

### The run shape

| Step | Work |
| --- | --- |
| T1S1 | The resolution of the positives, the universe, the metrics, the viability, the GO-set count, and the exclusion audit. The step reads each reference file once. |
| T1S2 | The matching and the balance report, one set per definition. The step reads the outputs of T1S1 only. |
| T1S3 | The report: the counts per route, per source, and per tier, the pros and the cons, and a recommendation. |

An exact betweenness with igraph on 10,000 nodes and about 150,000 edges takes under one minute. The OBO file reads without a library. A small parser of the `[Term]` stanzas gives the `is_a` parents.

### The output files

`positives_resolved.csv`, one row per input symbol:

| Column | Content |
| --- | --- |
| `input_symbol` | The symbol as given. |
| `route` | `human_symbol`, `human_synonym`, `mouse_ortholog`, `mouse_class`, `ambiguous`, or `unresolved`. |
| `status` | `resolved`, `many`, `ambiguous`, or `unresolved`. |
| `human_ensembl_gene_id` | The Ensembl gene id of the human gene. Empty when not resolved. |
| `human_symbol` | The human symbol. |
| `human_ncbi_gene_id` | The NCBI gene id of the human gene. |
| `mouse_mgi_id` | The MGI id, when the route goes through the mouse. |
| `class_size` | The size of the homology class, for `mouse_class`. |
| `in_universe` | `true` when the gene is in the universe. |

`universe_metrics.csv`, one row per universe gene:

| Column | Content |
| --- | --- |
| `ensembl_gene_id` | The join key. |
| `symbol` | The symbol of the gene table. |
| `median_tpm` | The median TPM of the tissue. |
| `degree` | The degree on the induced subgraph. 0 for a gene with no edge. |
| `betweenness` | The betweenness on the induced subgraph. 0 for a gene with no edge. |
| `in_string` | `false` for a gene with no STRING protein in the alias table. |
| `is_positive` | `true` for a resolved positive. |
| `viability` | `lethal`, `subviable`, `viable`, or `not_tested`. |
| `impc_tested` | `true` when a colony passed the tested rule. |
| `impc_zygosity` | `hom`, `het`, or empty. |
| `go_set_count` | The count of GO gene sets. Empty when the collection is absent. |

`exclusion_audit.csv`, one row per gene, source, and term:

| Column | Content |
| --- | --- |
| `ensembl_gene_id` | The join key. |
| `source` | `positives`, `mouse_phenotype`, `hpo`, `target_safety`, or `viability`. |
| `term_id` | The MP, HP, or UBERON id. For `positives`, the route. For `viability`, the call. |
| `term_label` | The label of the term. |
| `detail` | The zygosity, the biosample, or the dataset that gave the term. |

`negatives.csv`, one row per negative:

| Column | Content |
| --- | --- |
| `ensembl_gene_id` | The join key. |
| `symbol` | The symbol of the gene table. |
| `definition` | `annotation_free` or `tested_clean`. |
| `tier` | `annotation_free`, `tested_clean`, or `tested_clean_het`. |
| `cell` | The id of the joint cell. |
| `match_method` | `cell` or `nearest`. |
| `median_tpm`, `degree`, `betweenness`, `in_string`, `viability`, `go_set_count` | Copied from the universe table. |

`balance_report.json`, one object per definition:

| Field | Content |
| --- | --- |
| `parameters` | The tissue, the universe size, the target count, the score cutoff, the gene type, `exclude_lethal`, and the seed. |
| `sources_applied` | The four exclusion sources, and each dataset with its version. |
| `counts` | The positives in and outside the universe, the pool, the negatives, the shortfall, the nearest matches, the rows per route, per source, and per tier, the lethal share of the positives, and the no-STRING genes per class. |
| `covariates` | For each of `log_tpm`, `log_degree`, and `log_betweenness`: the SMD, the KS statistic, and its p-value. |
| `studied_gene_residual` | The SMD of `log_go_set_count`. Null when the GO collection is absent. |
| `auc` | The AUC of the logistic model on the three matched covariates. Null when a class holds fewer than 5 genes. |

### The reference names no location

The reference names each dataset by what it is:

- the GTEx median TPM table
- the STRING network with its Ensembl gene aliases
- the IMPC assertions, completeness, and viability files
- the HPO gene-to-phenotype table with its ontology
- the Open Targets mouse phenotypes and target safety events
- the MGI homology reports
- the MSigDB GO collection

It names no path, no file name, no format, and no tool. The catalog `contents` text carries the columns and the identifier space. Thus the agent finds each file by meaning.

## Risks / Trade-offs

- [The MGI host `www.informatics.jax.org` is not in the official hosts of the catalog test.] → The task adds the host. The test keeps its purpose: each artifact comes from its publisher.
- [The Open Targets part file names carry a UUID.] → The names are stable inside the 26.09 release. The `path` of the artifact stays clean, and only the URL carries the UUID.
- [The mouse-to-human map of Open Targets can differ from the MGI tables.] → The IMPC assertions file is the second source. A gene that one source excludes and the other does not goes into the audit with both flags.
- [The `tested_clean` pool is often below 2000 after the matching.] → The reference says to report the count and never to fill tier 1 from tier 2. The report gives the cons of each definition.
- [The viability rule removes hubs from the pool.] → The report gives the shortfall per cell and the count that the rule excluded. The parameter lets the customer compare.
- [The planner can select the enrichment agent for a gene list.] → The capability phrase names the task. The new routing rule names the safety route for the question. If a campaign still shows a wrong route, a later change adds a planner example.
- [The MSigDB GO collection is absent from a store.] → The report says that the studied-gene diagnostic was not computed. The matching does not depend on it.
- [A model reports a clean IMPC screen as proof of safety.] → The anti-pattern in the reference and in the `SKILL.md` names the failure.

## Migration Plan

No migration. No existing dataset changes, thus no install becomes invalid. An embedder that installs none of the six datasets sees no change. A run that asks for the set before the install gets a `request_clarification` from the planner. The capability phrase names the data classes, and the census lacks them. If a run starts without a source, the step writes the audit and no negatives file.

## Open Questions

None. The HPO acknowledgement in the product is a separate issue, not a question of this change.

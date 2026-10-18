## ADDED Requirements

### Requirement: The catalog holds the phenotype sources, the homology map, and the STRING aliases

The reference-data catalog MUST hold six datasets with the ids `impc-phenotyping`, `hpo-annotations`, `opentargets-mouse-phenotype`, `opentargets-target-safety-event`, `mgi-mouse-human-homology`, and `string-aliases-human`. The `string-aliases-human` dataset MUST hold the artifact `9606.protein.aliases.v12.0.txt.gz` at the version 12.0, as a companion of `string-ppi-human`. The `string-ppi-human` dataset MUST NOT change, because a new artifact at the same version invalidates the receipt of each existing install. Each of the six datasets MUST be opt-in, with `recommended: false`.

The `contents` text of each artifact MUST name the key columns and the identifier space. Where an absent row is not a negative, the text MUST say so. The `opentargets-mouse-phenotype` and `mgi-mouse-human-homology` datasets MUST declare no organism, because each table joins the mouse to the human. The `hpo-annotations` dataset MUST carry the identifier `LicenseRef-HPO` and the URL of the HPO license page, because the HPO license has no SPDX identifier.

#### Scenario: A caller finds the completeness file by description

- **WHEN** a caller queries the reference inventory for the IMPC procedures that a colony completed
- **THEN** the inventory gives the `procedureCompletenessAndPhenotypeHits.csv.gz` artifact, with its format and its contents text

#### Scenario: A default setup installs none of the six

- **WHEN** an embedder installs the recommended datasets only
- **THEN** none of the six datasets is in the install plan

#### Scenario: The STRING graph joins to GTEx on the Ensembl gene id

- **WHEN** an agent reads the `contents` text of the artifact of `string-aliases-human`
- **THEN** the text names the `Ensembl_gene` source as the filter that gives one Ensembl gene id per STRING protein id

#### Scenario: An existing STRING install stays intact

- **WHEN** an embedder with `string-ppi-human` installed reads the new catalog
- **THEN** the state of `string-ppi-human` stays `installed`, and the state of `string-aliases-human` is `missing`

#### Scenario: The catalog validates with the new entries

- **WHEN** the catalog is parsed
- **THEN** it validates, and each artifact of the six datasets has an `https` URL on an official host

### Requirement: The translational-safety pack gives the method

The `translational-safety` skill pack MUST hold the reference file `references/matched-negative-gene-set.md`. The reference MUST give these parts:

- the six resolution routes and their statuses: `human_symbol`, `human_synonym`, `mouse_ortholog`, `mouse_class`, `ambiguous`, and `unresolved`
- the class rule: every human gene of the homology class of a `mouse_class` positive is excluded, and the positive leaves the matching
- the universe rule: the protein-coding genes, the top 10,000 by the median TPM of the tissue, with the gene type and the tissue as parameters
- the network rule: the STRING edges with a combined score of 700 or more between two universe genes, joined on the Ensembl gene id
- the metrics: the degree and the betweenness on the induced subgraph
- the isolated-gene rule: a universe gene with no STRING node keeps degree 0 and betweenness 0, with the flag `in_string` false
- the four exclusion sources with their term ids, and the rule that DILImap is a positive source and not an exclusion source
- the viability rule: a homozygous lethal IMPC call excludes a gene from both tiers, and a subviable call is a flag
- the tested rule: a colony is tested when a procedure id with the prefix `IMPC_CBC_` is successful with the four parameters
- the two definitions `annotation_free` and `tested_clean`, each with its rule, its pros, and its cons, and the tier rule for the zygosity
- the matching cells: joint cells of 10 expression deciles by 5 degree quintiles by 5 betweenness quintiles, cut on the positives
- the matching draw: the quota per cell, the draw without replacement with a fixed seed, and the two shortfall rules
- the diagnostics: the SMD and the KS statistic per covariate, and one AUC of a logistic model on the three covariates
- the studied-gene diagnostic: the count of GO gene sets per gene, reported with its SMD and not matched
- the absent-source rule
- the five output files with their columns, as the design gives them
- the anti-patterns

The reference MUST name each dataset by what it is. It MUST NOT name a path, a directory, a file name, a format, or a tool. The tissue MUST be a parameter, and the liver MUST be the worked example. The `SKILL.md` of the pack MUST point to the reference, and it MUST list the reference in its References table. It MUST carry the five anti-patterns in its "Do NOT" section.

#### Scenario: An agent finds the method by a search

- **WHEN** the translational-safety agent calls `skill_search` with the query "matched negative"
- **THEN** the result names `references/matched-negative-gene-set.md` in the `translational-safety` pack

#### Scenario: The reference names no location

- **WHEN** the reference is read
- **THEN** it names the expression table, the network, the phenotype sources, and the homology map by what each is
- **AND** it names no path, no file name, no format, and no tool

#### Scenario: The tissue is a parameter

- **WHEN** a request names a tissue other than the liver
- **THEN** the tissue column, the exclusion terms, and the biosample id change with the tissue, and the method does not

### Requirement: The negative pool excludes a gene with an unknown liver label

A gene with a homozygous lethal viability call MUST be excluded from both tiers when the parameter `exclude_lethal` is on. The parameter MUST be on by default. A subviable call MUST be a value of the `viability` column, not an exclusion. The report MUST give the count of the candidates that the viability rule excluded, and the lethal share of the positives. A lethal knockout has no liver phenotype because nobody phenotyped it, thus its label is unknown.

#### Scenario: A lethal gene leaves the pool

- **WHEN** a universe gene has the viability call `lethal` and the parameter is on
- **THEN** the gene is in the exclusion audit under the source `viability`, and it is in no negatives file

#### Scenario: The request turns the parameter off

- **WHEN** the request sets `exclude_lethal` to off
- **THEN** the lethal genes stay in the pool, the `viability` column marks them, and the report states the choice

### Requirement: The matching balances the joint distribution

The matching MUST cut the positives into joint cells: 10 deciles of the log expression by 5 quintiles of the log degree by 5 quintiles of the log betweenness. The quota of a cell MUST be the target count times the share of the positives in the cell. A shortfall in a cell MUST take the nearest candidates in the standardized space. A universe gene with no STRING node MUST keep degree 0 and betweenness 0, and it MUST stay in the pool with the flag `in_string` false. A positive of the `mouse_class` route MUST leave the matching, and every human gene of its class MUST be excluded from the pool.

#### Scenario: A cell is short

- **WHEN** a cell holds fewer candidates than its quota
- **THEN** the step takes the nearest candidates in the standardized space, marks them `nearest` in the `match_method` column, and counts them in the report

#### Scenario: A gene with no STRING node

- **WHEN** a positive or a candidate has no node in the STRING graph
- **THEN** its degree and betweenness are 0, its `in_string` flag is false, and it stays in the matching

#### Scenario: A homology class with two human genes

- **WHEN** a mouse positive maps to a class with two human genes
- **THEN** both human genes are in the exclusion audit under the source `positives`, and the positive is in no cell

### Requirement: An absent exclusion source stops the negatives file

When a source of step 3 is absent from the reference store, the step MUST write the exclusion audit with the sources that it has. It MUST NOT write `negatives.csv`, and it MUST name the absent source in its summary. The `annotation_free` label MUST mean that all four sources were applied. Each definition names the sources that it needs. The `tested_clean` definition needs the IMPC completeness file, and both tiers need the viability table when `exclude_lethal` is on. A definition whose source is absent gets no set, and the other definition still runs. The capability phrase of the agent MUST name the data classes of the method. Thus the planner can ask for an absent source before the run.

#### Scenario: The HPO table is absent

- **WHEN** the step finds no HPO gene-to-phenotype table in the reference store
- **THEN** it writes `positives_resolved.csv`, `universe_metrics.csv`, and `exclusion_audit.csv` with three sources
- **AND** it writes no `negatives.csv`, and its summary names the HPO table

#### Scenario: The IMPC completeness file is absent

- **WHEN** the step finds the four exclusion sources but no IMPC completeness file
- **THEN** it writes the `annotation_free` set, it writes no `tested_clean` set, and its summary names the completeness file

#### Scenario: The planner sees the sources absent

- **WHEN** the planner reads a request for matched negatives, and the reference census shows no phenotype annotation source
- **THEN** the planner can end with a `request_clarification` that names the absent sources by what they are

### Requirement: The two definitions are explicit

A run that makes a matched negative gene set MUST make the set of the definition that the request names. If the request names no definition, the planner MUST ask with `request_clarification`, or the step MUST make both sets, each with its own diagnostics. A run MUST NOT make one set with a silent choice of the definition. A tier MUST NOT be filled from the other tier. A shortfall in the pool is a reported count.

#### Scenario: The request names a definition

- **WHEN** a request asks for `tested_clean` negatives
- **THEN** the run writes one negatives file with the `tested_clean` and `tested_clean_het` tiers, and one balance report

#### Scenario: The request names no definition and the planner asks

- **WHEN** the planner reads a request for matched negatives that names no definition
- **THEN** the planner can end with a `request_clarification` that names the two definitions, and the conversation agent relays the question

#### Scenario: The request names no definition and the plan proceeds

- **WHEN** a step briefing names no definition
- **THEN** the step makes both sets, with a `definition` column in the negatives file and a balance report per definition

#### Scenario: A short tier stays short

- **WHEN** the `tested_clean` pool holds fewer candidates than the quota of a cell
- **THEN** the step reports the shortfall, and it does not fill the tier from `annotation_free`

### Requirement: The translational-safety agent advertises the capability

The `AgentMeta` of `translational-safety-agent` MUST carry two capability phrases. The first is "matched negative gene set for a tissue risk benchmark from tissue expression, PPI connectivity, and mouse and human phenotype annotations (annotation-free or tested-clean negatives)". The second is "expression and PPI connectivity matching". Its `suitableFor` MUST include `gene-lists`.

#### Scenario: The planner sees the two definitions and the data classes

- **WHEN** the planner reads the agent catalog
- **THEN** the entry of `translational-safety-agent` names the two definitions and the three data classes in one capability phrase

#### Scenario: A gene list with a tissue risk question routes to the agent

- **WHEN** a request gives a gene list and asks for negatives matched on tissue expression and network connectivity
- **THEN** the planner assigns the steps to `translational-safety-agent`

### Requirement: One run writes the deliverable

A run on the positives MUST write five files: `output/positives_resolved.csv`, `output/universe_metrics.csv`, `output/exclusion_audit.csv`, `output/negatives.csv`, and `output/balance_report.json`. The step that resolves the positives MUST write the universe table with the covariates, the flags, and the viability. The same step MUST write the exclusion audit. Thus the matching step reads no reference file. The run MUST use the tools that the harness has. No new harness tool is necessary.

#### Scenario: A run on the customer list

- **WHEN** a run takes the 1215 symbols and the liver as the tissue
- **THEN** it writes the five files and the signed record
- **AND** the balance report gives the SMD and the KS statistic per covariate, one AUC per set, the seed, and the parameters

#### Scenario: The matching step reads no reference file

- **WHEN** the matching step runs
- **THEN** it reads the universe table and the exclusion audit of the first step, and it opens no reference file

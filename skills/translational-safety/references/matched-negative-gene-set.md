# Matched Negative Gene Set for a Tissue Risk Benchmark

A customer trains a classifier that marks a gene as a risk in one tissue. The risk occurs when a medicine reduces the expression of the gene in that tissue. The customer gives the positives as a list of gene symbols, often mouse and human mixed. The customer wants matched negatives: genes that the classifier cannot separate from the positives by tissue expression or by network connectivity.

This reference gives the method. The tissue is a parameter, and the liver is the worked example. A request that asks for a "matched negative" set, a "negative gene set", or "matched controls for a gene list" is this task.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `tissue` | liver | The tissue column of the expression table, and the organ of the exclusion terms. |
| `definition` | both | `annotation_free`, `tested_clean`, or both. See step 4. |
| `universe_size` | 10,000 | The count of genes in the universe. |
| `target_count` | 2000 | The count of negatives per definition. |
| `score_cutoff` | 700 | The minimum combined score of a network edge. |
| `gene_type` | protein-coding | The gene type of the universe. |
| `exclude_lethal` | on | A homozygous lethal knockout leaves the pool. See step 3. |
| `seed` | fixed and recorded | The seed of the draw. |

When the briefing names one definition, make that set. When the briefing names no definition, make both sets, each with its own diagnostics. Never make one set with a silent choice. Record each parameter in the balance report.

## The data

Ask the reference inventory available to you for each dataset by what it is. Read the format and the columns of the entry before you pick a reader. Never assume a path, and never hardcode one.

| The item | Ask for | It gives |
| --- | --- | --- |
| The gene tables | The NCBI gene table of the human, and the one of the mouse | The symbol, the synonyms, the gene type, and the Ensembl cross-reference of each gene. |
| The homology map | The MGI mouse-human homology reports | The one-to-one orthologs, and the full homology classes. |
| The expression | The GTEx median TPM table by tissue | One column per tissue, keyed on a versioned Ensembl gene id. |
| The network | The STRING human protein network, with its alias table | The edges with a combined score, and the Ensembl gene id of each protein. |
| The mouse screens | The IMPC phenotyping release: the assertions, the procedure completeness, and the viability calls | Which gene was tested, which gene had a hit, and which knockout is lethal. |
| The human phenotypes | The HPO gene-to-phenotype table, with its ontology | The annotated terms per gene, and the parents of each term. |
| The mouse phenotypes on human targets | The Open Targets mouse phenotype dataset | The IMPC and the MGI phenotypes, keyed on the human Ensembl gene id. |
| The safety events | The Open Targets target safety events | Curated liabilities per target, with the tissue of each event. |
| The studied-gene count | The MSigDB GO collection of the human | The gene sets, for a diagnostic only. |

### When a source is absent

Each definition has its own necessary sources. The `annotation_free` label means that these four exclusion sources were applied:

- the mouse phenotypes, from the Open Targets dataset and from the IMPC assertions
- the human phenotypes, from the gene-to-phenotype table and its ontology
- the safety events
- the viability calls, when `exclude_lethal` is on

The procedure completeness is also necessary for the `tested_clean` definition.

Two sources outside step 3 are also necessary. The alias table is necessary for each definition, because the network metrics need the Ensembl join. The homology reports are necessary when an input symbol matches the mouse table only.

If a source is absent, write the resolution, the universe table, and the audit with the sources that you have. Write no negatives file for a definition whose source is absent. Name the absent source in your summary. A negatives file with a wrong label is worse than none.

Three absent sources have their own rule:

- If the alias table is absent, compute no network metrics and write no negatives file. Report the absent table.
- If the homology reports are absent, give each mouse-only symbol the status `unresolved`. Report the absent reports.
- If the GO collection is absent, report that the diagnostic was not computed, and continue.

## Step 1: resolve the positives

Do not infer the species from the case of a symbol. Match each symbol against the human table and the mouse table. Then map a mouse gene to its human ortholog with the homology reports. Match the exact case first in both tables. Then match without case, and record that in the status detail.

| Route | Rule | Status |
| --- | --- | --- |
| `human_symbol` | An exact match on the human symbol column. | `resolved` |
| `human_synonym` | A match on the human synonyms column that names one gene. | `resolved` |
| `mouse_ortholog` | A match on the mouse symbol or synonyms column, then the one-to-one ortholog report. | `resolved` |
| `mouse_class` | No one-to-one ortholog: the homology class report, with the class size in the row. | `many` |
| `ambiguous` | More than one candidate human gene, from one table or from both tables. | `ambiguous` |
| `unresolved` | No match, or a mouse gene with no row in either homology report. | `unresolved` |

A synonym that names more than one human gene is `ambiguous`, not `human_synonym`. A homology class that holds no human gene is `unresolved`, not `mouse_class`.

The human Ensembl gene id comes from the cross-reference column of the human gene table. A human gene without an Ensembl cross-reference is `resolved`, but it is outside the universe.

A positive that does not reach one human gene still excludes each of its candidates. A `mouse_class` positive and an `ambiguous` positive both leave the matching. Every human gene of the class of a `mouse_class` positive is excluded from the pool in step 3, because one of them is the positive. Each candidate human gene of an `ambiguous` positive is excluded for the same reason.

The homology reports key the mouse gene on the MGI accession id and on the mouse NCBI gene id. The cross-reference column of the mouse gene table writes the MGI id with the prefix two times, for example `MGI:MGI:87854`. The reports and the mouse screens write it one time, for example `MGI:87854`. Strip the repeated prefix before a join, or join on the NCBI gene id instead. Write the single-prefix form in the `mouse_mgi_id` column.

## Step 2: the universe and the metrics

| Item | Rule |
| --- | --- |
| Gene type | The genes of the `gene_type` parameter, from the gene type column of the human gene table. |
| Universe | The top `universe_size` of those genes by the median TPM of the tissue. |
| Network | The edges with a combined score of `score_cutoff` or more between two universe genes. Join on the Ensembl gene id through the alias table, never on the symbol. |
| Metrics | The degree and the betweenness on that induced subgraph, with igraph. |
| Covariate columns | `log_tpm`, `log_degree`, and `log_betweenness`: the base-10 logarithm of the value plus 1. |
| Genes off the network | A universe gene with no STRING protein in the alias table gets the flag `in_string` false. |
| Isolated genes | A universe gene with a protein and no edge in the subgraph keeps the flag `in_string` true. |
| Both cases | The degree and the betweenness are 0, and the gene stays in the pool. |
| Reports | The count of universe genes with no node, per class. The positives outside the universe, which leave the matching. |

The expression table carries a versioned Ensembl gene id. Strip the version before the join. Compute the metrics once, on the one induced subgraph that the positives and the candidates share. An exact betweenness on 10,000 nodes and about 150,000 edges takes under one minute.

```python
import igraph as ig
import numpy as np
import pandas as pd

# edges: two columns of Ensembl gene ids, both genes in the universe, score >= cutoff
g = ig.Graph.TupleList(edges[["gene_a", "gene_b"]].itertuples(index=False), directed=False)
g.simplify()  # the network lists each edge twice, once per direction
metrics = pd.DataFrame({"ensembl_gene_id": g.vs["name"], "degree": g.degree(), "betweenness": g.betweenness()})
universe = universe.merge(metrics, on="ensembl_gene_id", how="left")
# the flag is the presence of a protein, not the presence of an edge: the vertex list
# holds only the genes that kept an edge inside the universe at the cutoff
universe["in_string"] = universe["ensembl_gene_id"].isin(alias_ensembl_ids)  # every ENSG of the alias table
universe[["degree", "betweenness"]] = universe[["degree", "betweenness"]].fillna(0)
for log_col, source_col in (("log_tpm", "median_tpm"), ("log_degree", "degree"), ("log_betweenness", "betweenness")):
    universe[log_col] = np.log10(universe[source_col] + 1)
```

## Step 3: the exclusion sources

| Source | Dataset | Rule for the liver |
| --- | --- | --- |
| Customer positives | The resolved list | Every resolved gene is excluded. Every human gene of a `mouse_class` class is excluded. |
| Mouse phenotypes | The Open Targets mouse phenotype dataset | A top-level class MP:0005370, or a term MP:0002941, MP:0005343, MP:0002968, or MP:0005344. |
| Human phenotypes | The HPO gene-to-phenotype table | A term in the descendants of HP:0001392 or HP:0004297, from the ontology. |
| Safety events | The Open Targets target safety events | A biosample tissue id UBERON_0002107 in either spelling, or an event text that holds hepat, liver, bilirubin, or steatos, without case. |
| Viability | The IMPC viability calls | A `lethal` call of a homozygous or a hemizygous colony, when `exclude_lethal` is on. A `subviable` call is a value of the `viability` column, not an exclusion. |

The four MP terms are the circulating ALT, AST, alkaline phosphatase, and bilirubin increases. They sit under the homeostasis class, not under the liver class, thus the list names them. The top-level class column of the mouse screens holds a list, thus split it before the test.

The tissue id of a safety event carries two spellings, `UBERON_0002107` and `UBERON:0002107`. Match both spellings. The event text is mixed case, for example `Hepatotoxicity` and `Increased, Liver Steatosis`, thus match it without case. A row can carry no biosample value, thus guard the test. One spelling with an exact-case text match finds about two thirds of the targets that carry a curated liver liability.

A `lethal` call of one colony takes precedence over a `subviable` and over a `viable` call of another colony of the same gene. Some genes carry both calls.

For another tissue, replace the organ class, the clinical terms, the HP roots, the biosample id, the event words, and the tested panel below. The method does not change. If the phenotyping release holds no procedure for the tissue, the `tested_clean` definition is not available. Report that, and make the `annotation_free` set.

DILImap is a positive source of the customer, not an exclusion dataset. The IMPC assertions are the second source for the mouse phenotypes. A gene that one source excludes and the other does not goes into the audit with both flags.

The gene-to-phenotype table lists the annotated terms only, not their ancestors. Take the descendant closure of each root before the filter. A small parser of the term stanzas of the ontology gives the parents:

```python
def parse_parents(lines):
    """Map each term id to its parent ids, from the is_a lines of the term stanzas."""
    parents, term = {}, None
    for raw in lines:
        line = raw.strip()
        if line == "[Term]":
            term = None
        elif line.startswith("id: HP:"):
            term = line[4:]
            parents.setdefault(term, set())
        elif line.startswith("is_a:") and term:
            parents[term].add(line[6:].split(" ")[0])
    return parents


def descendants(root, parents):
    children = {}
    for child, its_parents in parents.items():
        for parent in its_parents:
            children.setdefault(parent, set()).add(child)
    seen, stack = {root}, [root]
    while stack:
        for child in children.get(stack.pop(), ()):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return seen
```

A colony is tested when its successful procedures hold an id with the prefix `IMPC_CBC_`, and its successful parameters hold the four clinical chemistry names. The four names are `Alanine aminotransferase`, `Aspartate aminotransferase`, `Alkaline phosphatase`, and `Total bilirubin`. The parameter column holds the full name and never the abbreviation, thus a test for ALT or AST matches no row. Take the life stage `Early adult`. A gene with no tested colony is `not_tested`, which is not a clean screen.

## Step 4: the two definitions

| Definition | Rule | Pros | Cons |
| --- | --- | --- | --- |
| `annotation_free` (tier 2) | No hit in any source of step 3. | A large pool. The matching reaches the target. The exclusion is broad. | Absence of evidence: an unstudied gene passes. Unknown positives add label noise. A model can learn studied against unstudied. |
| `tested_clean` (tier 1) | Tier 2, and a tested early-adult colony with no significant term of step 3. | Evidence of absence. Less annotation bias. | A small pool, often below the target after the matching. IMPC selected the genes. A lethal knockout is absent, and such genes are hubs. Mouse evidence for a human label. |

The tier column records the zygosity. A homozygous colony gives `tested_clean`. A hemizygous colony of an X-linked gene is a full knockout, thus it also gives `tested_clean`. A heterozygote-only colony gives `tested_clean_het`.

Report the count of each tier. A het-only colony is often a lethal line, and `exclude_lethal` removes the lethal lines. But the het tier can still hold some hundreds of genes. Thus a count of zero is not the expected result, and it is not a check of the step.

## Step 5: the matching

| Item | Rule |
| --- | --- |
| Covariates | The `log_tpm`, `log_degree`, and `log_betweenness` columns of the universe table. |
| Cells | Joint cells: 10 deciles of the expression by 5 quintiles of the degree by 5 quintiles of the betweenness, cut on the positives. |
| Quota | `target_count` times the share of the positives in the cell. Give the rounding remainder to the largest fractions. |
| Draw | Without replacement, with the seed. |
| Shortfall in a cell | The nearest candidates in the standardized space, marked `nearest`. |
| Shortfall in the pool | Report the count. Never fill tier 1 from tier 2. |

Marginal bins leave the joint distribution separable, because the degree and the betweenness correlate. Cut the cells on the positives. Then place each candidate in the cell of its values.

```python
import numpy as np

COVARIATES = ["log_tpm", "log_degree", "log_betweenness"]


def inner_edges(values, k):
    """The k - 1 inner quantile edges of the positives."""
    return np.quantile(values, np.linspace(0, 1, k + 1)[1:-1])


def cell_ids(frame, cuts):
    parts = [np.searchsorted(edges, frame[col].to_numpy()) for col, edges in cuts.items()]
    return [f"{a}-{b}-{c}" for a, b, c in zip(*parts)]


cuts = {"log_tpm": inner_edges(pos["log_tpm"], 10), "log_degree": inner_edges(pos["log_degree"], 5), "log_betweenness": inner_edges(pos["log_betweenness"], 5)}
pos["cell"], pool["cell"] = cell_ids(pos, cuts), cell_ids(pool, cuts)

rng = np.random.default_rng(seed)
raw = pos["cell"].value_counts(normalize=True) * target_count
quota = np.floor(raw).astype(int)
remainder = target_count - int(quota.sum())
quota.loc[(raw - quota).sort_values(ascending=False).index[:remainder]] += 1  # the largest fractions take the remainder
picked, short = [], {}
for cell, n in quota.items():
    candidates = pool[pool["cell"] == cell]
    picked.append(candidates.sample(n=min(n, len(candidates)), random_state=rng).assign(match_method="cell"))
    if len(candidates) < n:
        short[cell] = n - len(candidates)
```

For a short cell, standardize the covariates on the positives. Then take the unpicked candidates nearest to the centroid of the positives of that cell, by Euclidean distance. Mark them `nearest`, and count them in the report.

## Step 6: the diagnostics

For each set, compute these values against the positives in the universe:

| Diagnostic | Rule | Target |
| --- | --- | --- |
| SMD | The standardized mean difference per matched covariate. | Below 0.1. |
| KS | The two-sample Kolmogorov-Smirnov statistic per matched covariate, with its p-value. | Small. |
| AUC | One logistic model on the three matched covariates, with cross-validation. | Near 0.5. |
| Studied-gene residual | The SMD of `log_go_set_count`. Reported, not matched, and with no KS. | State the value. |

The three matched covariates are `log_tpm`, `log_degree`, and `log_betweenness`. The studied-gene residual is not one of them.

If a target is not met, state why. A shortfall of the pool is the usual reason.

The cross-validation needs at least one positive and one negative in each fold. With fewer than 5 positives or 5 negatives in the universe, write `null` for the AUC, and give the count as the reason. Never write a NaN value, because a JSON reader refuses it.

```python
from scipy.stats import ks_2samp
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score


def smd(a, b):
    return (a.mean() - b.mean()) / np.sqrt((a.var(ddof=1) + b.var(ddof=1)) / 2)


FOLDS = 5

balance = {}
for c in COVARIATES:
    ks = ks_2samp(pos[c], neg[c])
    balance[c] = {"smd": smd(pos[c], neg[c]), "ks": ks.statistic, "ks_p": ks.pvalue}
# the GO-set count is reported, never matched, and it has no KS row
has_go = "log_go_set_count" in pos.columns
balance["studied_gene_residual"] = smd(pos["log_go_set_count"], neg["log_go_set_count"]) if has_go else None
X = pd.concat([pos[COVARIATES], neg[COVARIATES]])
y = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
# a fold with one class gives a NaN score, which no JSON reader accepts
if min(len(pos), len(neg)) >= FOLDS:
    balance["auc"] = float(cross_val_score(LogisticRegression(max_iter=1000), X, y, cv=FOLDS, scoring="roc_auc").mean())
else:
    balance["auc"] = None
```

## The output files

Write the five files under `output/`. The first step writes the first three. The matching step reads those three and writes the last two, and it opens no reference file.

`positives_resolved.csv`, one row per input symbol:

| Column | Content |
| --- | --- |
| `input_symbol` | The symbol as given. |
| `route` | `human_symbol`, `human_synonym`, `mouse_ortholog`, `mouse_class`, `ambiguous`, or `unresolved`. |
| `status` | `resolved`, `many`, `ambiguous`, or `unresolved`. |
| `status_detail` | The match without case, the count of the candidates, or the absent source. Empty for an exact match. |
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
| `log_tpm`, `log_degree`, `log_betweenness` | The base-10 logarithm of the value plus 1. The matched covariates. |
| `in_string` | `false` for a gene with no STRING protein in the alias table. |
| `is_positive` | `true` for a resolved positive. |
| `viability` | `lethal`, `subviable`, `viable`, or `not_tested`. |
| `impc_tested` | `true` when a colony passed the tested rule. |
| `impc_zygosity` | `hom`, `hemi`, `het`, or empty. |
| `go_set_count` | The count of GO gene sets. Empty when the collection is absent. |
| `log_go_set_count` | The base-10 logarithm of the count plus 1. The studied-gene residual. |

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
| `counts` | The positives in and outside the universe, the pool, the negatives, the shortfall, the nearest matches, the rows per route, per source, and per tier, the lethal share of the positives, and the no-node genes per class. |
| `covariates` | For each of `log_tpm`, `log_degree`, and `log_betweenness`: the SMD, the KS statistic, and its p-value. |
| `studied_gene_residual` | The SMD of `log_go_set_count`. Null when the GO collection is absent. |
| `auc` | The AUC of the logistic model on the three matched covariates. Null when a class holds fewer than 5 genes. |

## The report

Give the counts per route, per source, and per tier. Give the pros and the cons of each set, with the balance values. Give the count that the viability rule excluded, and the lethal share of the positives. Give the studied-gene residual. Then give one recommendation: which set the customer must use, and why. A clean IMPC screen is evidence of absence in the mouse, not proof of safety in the human.

## Do NOT

- Do not infer the species from the case of a symbol.
- Do not join the expression table to the network on the symbol: a renamed gene drops out in silence.
- Do not compute the metrics on the full network: the positives and the negatives must share one induced subgraph.
- Do not drop a gene with no network node: both classes must carry such genes in proportion.
- Do not set the `in_string` flag from the degree: a gene with a protein and no edge is on the network.
- Do not match an identifier or a free-text event with one spelling and one case: a curated liability then passes as a negative.
- Do not keep a lethal knockout as a negative by default: its label is unknown.
- Do not write a negatives file when a source of its definition is absent.
- Do not report a clean IMPC screen as proof of safety.
- Do not pad a short tier from the other tier.

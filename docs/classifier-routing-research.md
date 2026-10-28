# Research: fast classifier models for route decisions in the harness

> This document is research. It gives the facts and a recommendation. It is not
> a design.
>
> Sources: the TypeSafe documentation and API schema for `jev-1.14.0` and
> `jev-1.13.0`, the Pi documentation (`latest`), the Claude Haiku 5.5
> documentation, the OpenAI and Gemini price pages, the papers and model cards in
> "Sources", inflexa `main` at `3195eb9`, and bench `main` at `83c3d75`.
> Researched 2026-10-24.

## 1. The questions and the answers

1. **What is "Jev"?** A hosted, closed classifier model from TypeSafe. It answers
   typed questions with probabilities, and it generates no text. Section 2 gives
   the facts.
2. **Which other fast classifiers exist?** Encoder classifiers, router models,
   embedding similarity, and a small LLM with structured output. Section 3
   compares them.
3. **Where can inflexa use a classifier?** At a boundary only. The best
   candidate is the specialist choice of the ad hoc router. A classifier can
   select `agentId` and `capability`, but it cannot write the package list.
   Sections 4 and 5 give the map.
4. **How do we evaluate a classifier?** Against a labeled gold set of ad hoc
   requests, then in the `direct` lane of the bench. Section 6 gives the details.

## 2. Jev

| Property | Fact | Source |
| --- | --- | --- |
| The vendor | TypeSafe (`typesafe.ai`). `jev-agent.com` is a third party that resells access | TypeSafe site, `jev-agent.com` |
| The architecture | "A new model architecture, parallel sampler" that "generates all outputs in a single query". No parameter count, no base model | Launch post |
| The training method | Reinforcement Learning for Calibrated Decisions (RLCD) | Launch post |
| The questions | `choice` (1 to 255 options) gives the choice, a confidence, and the probability of each option. The other types are `score`, `noul`, and `box` | `openapi.json` |
| The context and the input | 64k tokens for each request and 32k for each question. Text only | `models.md` |
| The latency | Vendor: "70ms-500ms" end to end, from the US West Coast, with no p50. LiteLLM: p50 126.81 ms, p95 231.16 ms over 240 calls | Launch post, LiteLLM (not confirmed at a primary source) |
| The price | $0.042 for each 1M input tokens. Output tokens are free | `models.md`, OpenRouter API |
| The availability | The direct API is in early access. OpenRouter, Cloudflare Workers AI, and Vercel AI Gateway also serve it. Not on Bedrock | Provider pages |
| The license | Proprietary, with no weights. "Open Jev" is a name of community projects, not a TypeSafe release | Hugging Face, GitHub |
| The client | `POST https://api.typesafe.ai/v1/systemone`, not OpenAI-compatible. TypeScript SDK `@typesafe-ai/sdk` 0.7.0 (MIT) | `openapi.json`, SDK changelog |
| The data | "Jev is not trained on customer requests or responses." Zero data retention is for enterprise only | `models.md`, privacy policy |
| The versions | `jev-1.13.0` (Sept 2026) and `jev-1.14.0` (Oct 14, 2026). 1.13.0 got a 60-day deprecation notice | `models.md`, 1.14 post |

**Pi.** A Pi codemode script calls `models.classify(model, { state, questions })`.
The catalog lists `typesafe/jev-latest`, `openrouter/typesafe/jev-1.13`, and
`openai/gpt-6-luna` as classifier models (Pi docs, "Use classifier models").

**The accuracy evidence.**

- TypeSafe WorkflowEvals: Jev agrees with the labels in 67.8% of cases, against
  74.1% for GPT-6 Sol. The labels come from two LLMs, not from ground truth.
- LiteLLM: 95.00% tier match, against 73.75% for Claude Haiku 4.5, on 80
  synthetic cases with no review of the labels. This is third-party evidence.
- TypeSafe lists weak points: counts, dates, and a bias toward the first option.

**What Jev means for the harness.** `ChatProvider` sends chat requests
(`harness/src/providers/types.ts:51`, `types.ts:188`), and the Jev API is not a
chat API. Thus
Jev necessitates a new provider interface in the harness, and each embedder must
bind it (root `CLAUDE.md`, "The boundary between the CLI and the harness"). Jev
is also a new data processor for the request and the data-profile text.

## 3. Other fast classifiers and routers

### 3.1 Encoder classifiers

- **ModernBERT.** 149M or 395M parameters, 8,192 tokens of context, Apache-2.0
  (arXiv 2412.13663). A fine-tune necessitates labeled examples for each class.
  SetFit with 8 examples for each class is "competitive with fine-tuning RoBERTa
  Large on the full training set of 3k examples" (arXiv 2209.11055).
- **Zero-shot NLI.** `deberta-v3-large-zeroshot-v2.0` (MIT) gets a mean macro F1
  of 0.673 over 28 datasets. It does one forward pass for each label, thus its
  cost grows with the catalog (transformers.js `zero-shot-classification.js:124-133`).
- **GLiClass.** It scores each label in one pass, with a mean zero-shot F1 of
  0.7193 over 14 datasets (arXiv 2508.07662). Its Node support is weak.
- **From TypeScript.** transformers.js 4.3.1 runs ModernBERT and DeBERTa-v2 in
  Node on `onnxruntime-node`. That is a new dependency and a model download. I
  found no official latency for Node on a CPU.

### 3.2 Router models

- **Arch-Router-1.5B.** A Qwen2.5-1.5B fine-tune that maps a request to a
  free-text policy, and a policy can be a specialist. It scores 93.17, against
  92.79 for Claude Sonnet 3.7, and it takes 51 ms on an L40S (arXiv 2506.16655).
  Commercial use necessitates "a separate commercial license from DigitalOcean".
- **RouteLLM** selects between one strong and one weak model (arXiv 2406.18665).
  The NVIDIA LLM Router, Not Diamond, and Martian also select an LLM. None of
  them selects a specialist.
- **NVIDIA prompt-task-and-complexity-classifier** uses a fixed set of generic
  task labels, thus it cannot learn the catalog.

### 3.3 Embedding similarity

- **The method.** Embed example requests for each route. Select the nearest
  centroid. Give no route below a threshold. Tool2Vec uses this method to select
  tools (arXiv 2409.02141). `semantic-router` does it in Python only.
- **The models.** `text-embedding-3-small` costs $0.02 for each 1M tokens
  (OpenAI price page). `bge-small-en-v1.5` gets 85.74 on Banking77 with a linear
  classifier on its vectors (model card). I found no primary benchmark of the
  nearest centroid with these models.
- **The harness has it.** The conversation agent always has an
  `EmbeddingProvider` (`harness/src/agents/conversation-agent.ts:140`,
  `harness/src/providers/types.ts:211-221`). The CLI local mode runs bge-small in
  a `llama-server` sidecar (`cli/src/modules/embedding/local-provider.ts:1-30`).
- **A constraint.** The vector width differs by provider. Thus the route vectors
  must come from the bound provider at boot, not from a shipped constant.

### 3.4 A small LLM as the utility model

- **Claude Haiku 5.5** (`claude-haiku-5-5`, Oct 7, 2026) costs $0.10 input and
  $0.50 output for each 1M tokens. Anthropic names "classification, routing,
  extraction" as its work, with no latency number. Thinking is on by default.
- **CAUTION:** Haiku 5.5 runs a `bio` safety classifier, and a retry of a
  refusal "usually returns another refusal". The router falls back on a reply
  with no `submit_route` call (`harness/src/tools/ad-hoc-router.ts:295-313`).
  Thus a refusal sends a bioinformatics request to `scientific-executor`.
- **OpenAI `gpt-6-luna`** costs $0.10 and $0.50. **Gemini 3.5 Flash-Lite** costs
  $0.30 and $2.50. Both support structured outputs.
- None of these vendors publish a time to the first token.

### 3.5 Comparison for one ad hoc route

I measured the router input at about 14,000 characters: 1,256 for the shared
prompt sections, 6,403 for the catalog, and up to 6,000 for the orientation
(`harness/src/app/data-profile-orientation.ts:57`). I estimate 4,000 input tokens
and 300 output tokens. The costs are my arithmetic.

| Mechanism | Latency | Cost for each route | From TypeScript |
| --- | --- | --- | --- |
| Jev | p50 127 ms (third party) | about $0.0002 | `@typesafe-ai/sdk`, new provider interface |
| Embedding centroid | One embedding call | below $0.00001 | `EmbeddingProvider`, exists |
| Encoder in Node | No number | Local compute | transformers.js, new dependency |
| Arch-Router | 51 ms on a GPU | A GPU host | OpenAI-compatible endpoint, license limit |
| Haiku 5.5 | No number | about $0.0006 | `ChatProvider`, exists |
| The current call on Opus 5.5 | No number | about $0.02 | `ChatProvider`, exists |

No candidate has accuracy evidence on this task.

## 4. The constraint: a router decides at a boundary

The system prompt is a function of the agent type only, and the declared tools
stay the same for the whole conversation (`harness/CLAUDE.md:171-206`,
`harness/src/agents/sandbox/shared.ts:328-336`). A tool mask limits the calls
and keeps the prefix (`harness/src/loop/tool-mask.ts:1-7`).

Thus a router decides at the start of a sub-agent, of a step, or of a session.
Inside a loop, a classifier can act only inside a tool, because a tool result is
new content after the prefix.

## 5. The use cases in inflexa

### 5.1 The ad hoc router

The router makes one chat call through the utility provider, with one
`submit_route` tool and a deadline of 10 s or more
(`harness/src/tools/ad-hoc-router.ts:248-283`). The spec says that the harness
"MUST make one structured call through its required utility provider/model"
(`harness/openspec/specs/adhoc-analysis-execution/spec.md:56-57`).

| Field | The value set | Can a classifier select it? |
| --- | --- | --- |
| `agentId` | The plannable catalog (`harness/src/agents/sandbox-catalog.ts:21-27`) | Yes. One choice question over a closed set |
| `capability` | The phrases of the selected agent (`ad-hoc-router.ts:332-333`) | Yes, as a second choice question. A phrase selects the reference-data requirement (`sandbox-catalog.ts:36-39`) |
| `resources` | CPU, memory, and GPU inside the policy bounds (`ad-hoc-router.ts:98-111`) | Partly, as a size class. Absent, the defaults apply (`ad-hoc-router.ts:315-316`) |
| `packages` | An open set in the package grammar (`ad-hoc-router.ts:43-46`) | No. A classifier cannot write a package name |
| `rationale` | Free text for the step agent (`ad-hoc-router.ts:42`) | No. A template is the fallback (`ad-hoc-router.ts:318-323`) |

Three facts set the value of a change:

- **The default router is a frontier model.** The utility model is the
  conversation model unless `models.agents.utility` is set
  (`cli/src/lib/config.ts:209-222`, `cli/src/modules/harness/runtime.ts:750-766`).
- **The router is a small part of a run.** It is one call before a sandbox step
  that can make up to 200 model requests
  (`harness/src/agents/sandbox/types.ts:101`). A wrong specialist runs the whole
  step with the wrong prompt and skills. Thus accuracy matters more than latency.
- **A route with no packages works, at a cost.** The step gets a caveat, and the
  link pass links nothing (`harness/src/tools/execute-analysis.ts:409-413`). The
  step agent can link packages when the embedder binds `extendAnalysisFarm`
  (`shared.ts:361`).

**The call:** a classifier can replace the `agentId` and `capability` part. The
`packages` part stays with an LLM, or moves into the step.

### 5.2 Skill selection

`meta.skills` is the allowlist of an agent (`harness/src/agents/sandbox/types.ts:82`),
thus the agent choice selects the skills. `skill_search` is a keyword match that
ranks a file by the count of query words in it
(`harness/src/tools/sandbox/skills.ts:94-138`). An embedding rank inside
`skill_search` keeps the prefix. The sandbox embedding is optional
(`shared.ts:136`), thus the keyword match stays the fallback. The value is
largest for `scientific-executor`, which declares each skill
(`scientific-executor.ts:24-45`).

### 5.3 Tool-set selection at a sub-agent boundary

The tools of a sandbox agent are the substrate plus `meta.tools`
(`shared.ts:354-371`). Thus to select a tool set is to select an agent, as in
section 5.1. A mask for each step exists
(`harness/src/workflows/sandbox-step.ts:717`). But the model still sees each
tool, and each refused call costs a request. RAG-MCP selects the tools of each
request (arXiv 2505.03275), and the append-only rules forbid that.

### 5.4 Classification inside tools

| Case | Today | Can a classifier replace it? |
| --- | --- | --- |
| `run_inflexa` approval (`cli/src/modules/harness/inflexa_tool.ts:126-159`) | A commander parse and a registration policy | No. It is a security boundary, and the user approves exactly what runs |
| Input scan (`harness/src/input-scan/index.ts:1-6`, `formats.ts:1-17`) | Magic bytes and an extension table | No. "The scan observes. The profiler agent groups" |
| Input sanitization (`harness/src/input-sanitization.ts:65-92`) | Patterns for prefixed secrets | No. A prompt-injection detector, for example Llama Prompt Guard 2 (22M or 86M parameters), is a separate addition |
| Literature relevance (`harness/src/literature/sources/pubmed.ts:274`) | The source sorts by relevance, and the reviewer agent reads | A score for each abstract can filter inside the search tool. It adds a call to each search |
| Citation match (`harness/src/citations/match.ts:13-18`) | Token similarity with thresholds | No. The match must be deterministic |
| Knowledge situation (`harness/src/tools/knowledge/situation.ts:12-40`) | The planner fills typed enums | No gain. The planner already runs |
| File metadata (`harness/src/execution/artifact-metadata.ts:1-15`) | A continuation of the step agent | No. It writes text |
| The agent of a plan step (`sandbox-catalog.ts:52-62`) | The planner selects it | Only as a check that flags a disagreement |

## 6. The evaluation

### 6.1 The labeled data

1. **A gold set.** A domain expert writes ad hoc requests for each plannable
   specialist, from its `capabilities` and `suitableFor`. Give each request a set
   of permitted specialists, because the catalog overlaps. Add the expected
   capability and a data-profile orientation (`ad-hoc-router.ts:246`). Keep a
   held-out split apart from the route examples.
2. **Bench rollouts.** In the `direct` flow, the agent routes one request in the
   ad hoc mode (bench `docs/bench-plan/05-contenders.md:227-228`). The
   `log.jsonl` of a rollout holds the "ad hoc route selected" record
   (`05-contenders.md:304`, `ad-hoc-router.ts:334`). The task families are bulk
   RNA-seq and single cell, thus the bench covers few specialists. I found no
   archived rollouts, and the origin has no `results` branch.
3. **Traces.** The CLI writes the harness log to `~/.inflexa/logs`
   (`harness/CLAUDE.md:530-540`). The route records give real request-to-route
   pairs with no gold label. Use them for the class distribution and for a
   shadow comparison.

### 6.2 The metrics

- Top-1 `agentId` accuracy against the permitted set, and the macro F1.
- `capability` exact match, where the capability has a data requirement.
- The fallback rate by `fallbackClass` (`ad-hoc-router.ts:71`), with the
  refusals apart.
- The coverage at a confidence threshold, and the accuracy on that coverage.
- p50 and p95 latency at the tool. The usage record has no duration field
  (`harness/src/billing/usage-recorder.ts:21-53`), thus the script must time the
  call.
- The cost for each route, from the tokens of the usage record.
- The bench verified recovery rate in the `direct` lane, paired by seed.

### 6.3 The decision threshold

A classifier replaces the `agentId` and `capability` part only if each condition
is true:

- On the held-out split, its top-1 accuracy is not lower than the LLM call on
  Haiku 5.5 by more than 2 percentage points. Use the lower bound of a paired 95%
  confidence interval.
- At the selected threshold, the coverage is 80% or more, with an accuracy equal
  to the LLM call or higher. A request below the threshold goes to the LLM call.
- The bench `direct` lane shows no drop of the verified recovery rate.
- Its p95 latency is below the p50 of the LLM call.

These numbers are my proposal, not a measurement.

## 7. The recommendation

**The call:** do not add Jev now. Set the utility model to Claude Haiku 5.5, and
build the gold set. Then evaluate the embedding centroid against that LLM call,
as a cascade for `agentId` and `capability` only.

The reasons:

- **Accuracy is the open metric.** The route is a small part of the cost and the
  time of a run, and no candidate has evidence on this task.
- **The cheap path exists.** `models.agents.utility` sets the router model. On
  Haiku 5.5 a route costs about $0.0006, against about $0.02 on Opus 5.5. Jev
  saves about $0.0004 more.
- **The embedding centroid adds nothing new.** No dependency, no vendor, and no
  provider interface.
- **Jev adds three new things.** A provider interface, a data processor, and an
  early-access API. Its evidence is agreement with LLM labels and 80 synthetic
  cases.
- **The refusals come first.** Measure the Haiku 5.5 `bio` refusals on the gold
  set before the switch.

If the embedding centroid fails the threshold, Jev through OpenRouter is the
second candidate, because its choice questions match the shape of the catalog.

## 8. Open questions

1. Must a classifier route keep a package list? If not, the package cost moves
   into the step.
2. Can a managed deployment send the request and the data-profile text to
   TypeSafe or OpenRouter?
3. Does the AI SDK provider map a Claude refusal to an error or to a reply with
   no tool call? The fallback class is `provider_error` or `malformed`.
4. A cascade changes the spec requirement of "one structured call". Does that
   spec change come before the evaluation, or after it?
5. Who labels the gold set, and how many requests does each specialist get?

## Sources

- TypeSafe launch post: <https://www.typesafe.ai/blog/introducing-system-one-models-and-jev>
- TypeSafe models: <https://docs.typesafe.ai/models.md>
- TypeSafe API schema: <https://api.typesafe.ai/openapi.json>
- TypeSafe weak points: <https://docs.typesafe.ai/model-jaggedness/jev-1.13.md>
- TypeSafe SDK changelog: <https://docs.typesafe.ai/sdk/javascript/changelog.md>
- TypeSafe Jev 1.14: <https://www.typesafe.ai/blog/jev-1-14>
- TypeSafe evals: <https://evals.typesafe.ai>, <https://github.com/typesafe-ai/WorkflowEvals>
- TypeSafe privacy policy: <https://www.typesafe.ai/legal/privacy-policy>
- OpenRouter Jev guide: <https://openrouter.ai/docs/guides/community/jev>
- Cloudflare Workers AI Jev: <https://developers.cloudflare.com/ai/models/typesafe/jev/>
- Vercel AI Gateway Jev: <https://vercel.com/ai-gateway/models/jev>
- `jev-agent.com` (third party): <https://jev-agent.com/>
- Pi models: <https://pi.dev/docs/latest/models>, Pi codemode: <https://pi.dev/docs/latest/codemode>
- LiteLLM benchmark (third party): <https://docs.litellm.ai/blog/jev-auto-router-benchmark>
- ModernBERT: <https://arxiv.org/abs/2412.13663>
- SetFit: <https://arxiv.org/abs/2209.11055>
- Zero-shot NLI: <https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0>
- GLiClass: <https://arxiv.org/abs/2508.07662>
- transformers.js: <https://github.com/huggingface/transformers.js>
- Arch-Router: <https://arxiv.org/abs/2506.16655>, <https://huggingface.co/katanemo/Arch-Router-1.5B/blob/main/LICENSE>
- RouteLLM: <https://arxiv.org/abs/2406.18665>
- NVIDIA classifier: <https://huggingface.co/nvidia/prompt-task-and-complexity-classifier>
- Tool2Vec: <https://arxiv.org/abs/2409.02141>
- RAG-MCP: <https://arxiv.org/abs/2505.03275>
- semantic-router: <https://github.com/aurelio-labs/semantic-router>
- OpenAI price page: <https://developers.openai.com/api/docs/pricing>
- bge-small-en-v1.5: <https://huggingface.co/BAAI/bge-small-en-v1.5>
- Claude Haiku 5.5: <https://platform.claude.com/docs/en/models/haiku-5-5/overview>
- Claude Haiku 5.5 refusals: <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5>
- Gemini price page: <https://ai.google.dev/gemini-api/docs/pricing>
- Llama Prompt Guard 2: <https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M>

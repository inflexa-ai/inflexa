# Spec Delta

## REMOVED Requirements

### Requirement: Sandbox standards teach literature grounding during execution

**Reason**: The requirement pinned the wording of `sandbox-standards`, and it named the tools `search_pubmed` and `get_article_details`, which do not exist. The code has one `pubmed` tool with an `action`. Prompt text is not a spec contract.

**Migration**: None. "The step summary continues the conversation of the step agent" keeps the code contract: the mask of the summary continuation lets only `read_file`, `grep`, and `read_tool_output` run.

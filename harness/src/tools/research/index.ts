/**
 * Research barrel — dependency-bearing planning, run inspection, the
 * literature-reviewer and analogical-reasoner sub-agents, developer-docs
 * lookup, and the cross-domain search tools the analogical-reasoner uses.
 * Dep-bearing tools are factory closures (`createXTool(deps)`); pure tools
 * are module-scope `defineTool` values.
 */

export * from "./generate-plan.js";
export * from "./inspect-run.js";
export * from "./inspect-data-profile.js";
export * from "./literature-reviewer.js";
export * from "./generate-analogy-report.js";
export * from "./context7-docs.js";
export * from "./search-semantic-scholar.js";
export * from "./search-arxiv.js";
export * from "./search-github-repos.js";

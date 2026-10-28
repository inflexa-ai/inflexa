# Spec Delta

## MODIFIED Requirements

### Requirement: `web_search` attaches only when the embedder injects a web-search engine

The conversation agent deps MUST accept an optional web-search engine. When the embedder injects no engine, `web_search` MUST NOT attach to any roster or to any list of script tools. Its description and its catalog line in `run_script` MUST then never enter a model context. When the embedder injects an engine, `web_search` MUST be a script tool of the conversation agent only (refer to the script-tools capability).

#### Scenario: No URL, no tool

- **WHEN** the composition runs with no web-search engine
- **THEN** the conversation agent holds no `web_search`, in its tools or in its script tools

#### Scenario: A URL attaches the tool

- **WHEN** the composition runs with a web-search engine
- **THEN** the script tools of the conversation agent hold `web_search`

### Requirement: `web_fetch` attaches without a SearXNG URL

`web_fetch` MUST be a script tool of the conversation agent, with or without a web-search engine. It reads a URL that the model or the user selects, not a search result.

#### Scenario: `web_fetch` works without SearXNG

- **WHEN** the composition runs with no web-search engine
- **THEN** the script tools of the conversation agent hold `web_fetch`

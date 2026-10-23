# Spec Delta

## MODIFIED Requirements

### Requirement: The boot hands the SearXNG URL to the harness

The CLI SHALL derive the SearXNG base URL from the channel port and SHALL build the harness's web-search engine over it at the composition root, injecting the engine into the conversation assembly so the conversation agent roster holds `web_search`. The URL is a stack constant the CLI owns: there SHALL be no config field and no environment variable for it, the same rule as the proxy endpoint.

#### Scenario: The conversation deps carry the URL

- **WHEN** the harness runtime boots the conversation assembly
- **THEN** the conversation deps hold a web-search engine built over `http://127.0.0.1:<channel port>`

## ADDED Requirements

### Requirement: The openai-compatible arm sends a tool picture as a part when the endpoint takes parts

The `openai-compatible` config MUST accept `supportsMultiPartToolContent`. The arm MUST pass the value to the package. When the flag is `true` and the config gives no `imageToolResults`, the arm MUST set `imageToolResults: true`. When the flag is absent, the arm MUST leave the capability absent. A config value MUST override the default in both directions.

#### Scenario: An endpoint that takes parts gets the picture as an image part

- **WHEN** an `openai-compatible` arm with `supportsMultiPartToolContent: true` sends a history whose tool result carries a text part and a picture
- **THEN** the tool message of the request carries a `text` part and an `image_url` part with the data URL of the picture

#### Scenario: An endpoint with no flag carries no picture

- **WHEN** an `openai-compatible` arm has no `supportsMultiPartToolContent`
- **THEN** the provider leaves `imageToolResults` absent, and the loop drops a tool picture with a warn

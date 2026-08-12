# harness-agent-loop Delta

## ADDED Requirements

### Requirement: The loop places a tool picture by the capability precedence

The loop MUST place a tool picture by this precedence: the tool result, then a user message, then the drop. When `imageToolResults` is set, the picture MUST ride the tool result as an image block. When `imageToolResults` is absent and `imageUserMessages` is set, the tool result MUST keep its JSON text. The loop MUST then append one user message directly after the tool message of the round. That message MUST batch each dropped picture of the round.

For each picture, the message MUST carry a text part and then a file part. The text part MUST name the tool call. The file part MUST carry the media type and the bytes. When both flags are absent, the loop MUST drop the picture and record a warn. The transcript MUST stay append-only in every mode. The fallback message MUST carry the synthetic marker of the harness namespace, thus it opens no conversation turn.

#### Scenario: The fallback carries the picture

- **GIVEN** a provider that advertises `imageUserMessages` and not `imageToolResults`
- **WHEN** a tool result of a round carries a picture
- **THEN** the round ends with one user message that holds the picture and names its tool call, and the tool result keeps its JSON text

#### Scenario: One message batches the pictures of a round

- **WHEN** two tool calls of one round each give a picture
- **THEN** one user message after the tool message carries both pictures, in the order of the tool calls

#### Scenario: The tool-result path stays exclusive

- **GIVEN** a provider that advertises both picture flags
- **WHEN** a tool result carries a picture
- **THEN** the picture rides the tool result only, and the loop appends no fallback message

#### Scenario: The fallback message opens no conversation turn

- **WHEN** the loop appends the fallback message
- **THEN** the message carries the synthetic marker, and a turn-boundary reader does not read it as a turn start

#### Scenario: A wire with neither flag drops the picture

- **GIVEN** a provider that advertises neither picture flag
- **WHEN** a tool result carries a picture
- **THEN** the loop drops the picture, keeps the JSON text, and records a warn

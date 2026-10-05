# Delta: harness-agent-loop

## MODIFIED Requirements

### Requirement: The loop places a tool picture by the capability precedence

The loop MUST place a tool picture by this precedence: the tool result, then a user message, then the drop. When `imageToolResults` is set, the picture MUST ride the tool result as an image block. When `imageToolResults` is absent and `imageUserMessages` is set, the tool result MUST keep its JSON text. The loop MUST then append one user message directly after the tool message of the round. That message MUST batch each dropped picture of the round.

For each picture, the message MUST carry a text part and then a file part. The text part MUST name the tool call. The file part MUST carry the media type and the bytes. When both flags are absent, the loop MUST drop the picture and record a warn. The transcript MUST stay append-only in every mode. The fallback message MUST carry the synthetic marker of the harness namespace, thus it opens no conversation turn.

A tool ok value MAY carry an ordered list of pictures, and the loop MUST keep the order of the list on the wire. The one-picture convention MUST read as a list of one, thus a tool that attaches one picture and a tool that attaches a list meet the loop in the same shape. The placement precedence above applies to the list, and no capability flag distinguishes the list: a wire that declares a picture capability declares it for the list.

When `imageToolResults` is set, the tool result MUST carry the JSON text part and then one image block per picture, in order. When `imageToolResults` is absent and `imageUserMessages` is set, the fallback user message MUST carry each picture of the result in order, each behind a text part that names the tool call; a result with several pictures MUST number them. When both flags are absent, the loop MUST drop every picture of the result, keep the JSON text, and record one warn that carries the count.

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

#### Scenario: A multi-picture result rides the tool result in order

- **GIVEN** a provider that advertises `imageToolResults`
- **WHEN** a tool result carries two pictures
- **THEN** the tool result carries the JSON text part and then the two image blocks, in the order the tool gave

#### Scenario: A multi-picture result rides the fallback message in order

- **GIVEN** a provider that advertises `imageUserMessages` and not `imageToolResults`
- **WHEN** a tool result carries two pictures
- **THEN** the fallback user message carries both pictures in order, each behind a numbered text part that names the tool call

#### Scenario: A wire with neither flag drops the list with one counted warn

- **GIVEN** a provider that advertises neither picture flag
- **WHEN** a tool result carries two pictures
- **THEN** the loop drops both, keeps the JSON text, and records one warn that carries the count of two

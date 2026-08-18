# Delta: harness-agent-loop

## MODIFIED Requirements

### Requirement: The loop places a tool picture by the capability precedence

A tool ok value MAY carry an ordered list of pictures, and the loop MUST keep the order of the list on the wire. The one-picture convention MUST read as a list of one, thus a tool that attaches one picture and a tool that attaches a list meet the loop in the same shape. The placement precedence is unchanged, and no capability flag distinguishes the list: a wire that declares a picture capability declares it for the list.

When `imageToolResults` is set, the tool result MUST carry the JSON text part and then one image block per picture, in order. When `imageToolResults` is absent and `imageUserMessages` is set, the fallback user message MUST carry each picture of the result in order, each behind a text part that names the tool call; a result with several pictures MUST number them. When both flags are absent, the loop MUST drop every picture of the result, keep the JSON text, and record one warn that carries the count.

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

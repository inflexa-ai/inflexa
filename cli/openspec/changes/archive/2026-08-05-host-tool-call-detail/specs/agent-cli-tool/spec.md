## ADDED Requirements

### Requirement: run_inflexa describes its call as the argv that will run

`run_inflexa` SHALL declare a `describeCall` hook naming the argv the call will spawn. The hook SHALL describe the CLASSIFIER-NORMALIZED argv — the value every runnable verdict carries — rather than the raw argv the model submitted, and SHALL encode each element the same way the approval prompt encodes it, so an element containing whitespace reads as one quoted word in both places.

The hook SHALL NOT run the classifier. Classification is asynchronous and decides whether an argv may run and under what policy; the argv itself is produced by a synchronous, pure normalization that the classifier applies first and every verdict returns unchanged. The hook SHALL reuse that normalization directly.

The detail SHALL omit the leading `inflexa` word the approval prompt carries, because the surface rendering the detail prints the tool's name beside it.

This tool's standing invariant is that what the user approves is exactly what executes. A chip that named a different argv from the dialog — or encoded the same argv differently — would weaken that guarantee for precisely the inputs where word boundaries are ambiguous.

#### Scenario: A word-argv call names its own words

- **GIVEN** a call whose argv is already a list of words
- **WHEN** the tool call is rendered
- **THEN** the detail is those words, space-separated

#### Scenario: A single-element command string is described as the words that will run

- **GIVEN** a call whose argv is one element containing whitespace, which the normalization tokenizes into several words
- **WHEN** the tool call is rendered
- **THEN** the detail names the tokenized words, matching what the tool spawns, not the single submitted element

#### Scenario: The chip and the approval prompt encode one argv identically

- **GIVEN** a call whose argv contains an element with embedded whitespace
- **WHEN** the call is rendered and its approval prompt is raised
- **THEN** that element is encoded the same way in both, differing only in the prompt's leading `inflexa`

#### Scenario: A rejected argv is still described

- **GIVEN** a call whose argv does not resolve to a runnable command
- **WHEN** the tool call is rendered
- **THEN** the detail names the argv, because the detail is computed before dispatch and does not depend on the verdict

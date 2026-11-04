# Spec Delta

## ADDED Requirements

### Requirement: The stream of a turn carries each retry of a model request

The turn MUST write each `data-model-retry` part of a model request to the durable stream of the workflow that runs the request. Each reader of the turn MUST get each retry part that the stream holds. A reader that opens during the retries of a request MUST get the earlier parts in order, and then each later part. The fold of the frames of a reader thus shows the newest retry of the request. The stored transcript of the turn MUST NOT hold a `data-model-retry` part.

#### Scenario: A reader that opens before the retries

- **GIVEN** a turn whose model request fails with `503` two times, and then gives a reply
- **WHEN** a client reads the turn by its id before the first retry
- **THEN** the client gets two `data-model-retry` parts with the same request id and the retries 1 and 2
- **AND** the client gets each part when the turn writes it

#### Scenario: A reader that opens during the retries

- **GIVEN** a turn whose model request waits for its second retry
- **WHEN** a client reads the turn by its id
- **THEN** the client gets the `data-model-retry` part of the first retry from the start of the stream
- **AND** the client gets the part of the second retry when the turn writes it

#### Scenario: The transcript holds no retry

- **GIVEN** a turn whose model request needed a retry, and then gave a reply
- **WHEN** the turn ends
- **THEN** the stored messages of the turn hold no `data-model-retry` part

# Spec Delta

## ADDED Requirements

### Requirement: A plan approval renders as one line of its event entry

`MessageBlock` MUST render a `data-plan-approval` part as the one text line `Approved <planId>.`, through the markdown body of the block. The part rides a `system` message, thus the line renders inside the event entry, beside the run card of the record. The line needs no new block visual.

#### Scenario: A reloaded approval shows its line and its run card

- **GIVEN** a `system` message with a `data-plan-approval` part of `pln-0000000a` and a `data-run-card` part
- **WHEN** `MessageBlock` renders the message
- **THEN** the event entry shows `Approved pln-0000000a.` and the run card

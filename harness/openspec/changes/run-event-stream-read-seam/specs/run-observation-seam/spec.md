## MODIFIED Requirements

### Requirement: Observation carries run and step state only

The snapshot SHALL describe run-level and step-level state. It SHALL NOT carry sub-step
detail — tool calls, model rounds, sandbox file trees, command output, or agent-loop
events. That detail is carried by the `run-event-stream` capability, which reads the
workflow's durable event stream; the two seams are a deliberate pair, and sub-step
detail belongs to that one rather than being added here.

#### Scenario: Sub-step activity is absent from the snapshot

- **WHEN** a running step is executing a sandbox command
- **THEN** the snapshot reports the step as running and carries nothing about the command itself

#### Scenario: A host needing sub-step detail uses the event stream

- **WHEN** an embedder needs to show what a running step is currently doing
- **THEN** it subscribes to the run-event stream rather than extending this snapshot

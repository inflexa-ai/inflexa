## MODIFIED Requirements

### Requirement: The live display recorder preserves the replayable turn

One conversation display recorder SHALL observe every top-level provider-text, tool-lifecycle, durable conversation-data, and approval event that the live surface observes. It SHALL produce complete UI messages whose parts preserve visible emission order, copy payloads at receipt, exclude transient parts, and fold reconciling parts latest-wins by stable id — a tool call reaching its finished state and an approval reaching its terminal status being the same operation, each replacing in the position it first took.

The recorder SHALL exclude the display parts of a sub-agent, and an entry SHALL hold no text of the sub-agent. It SHALL keep each tool call of a sub-agent as one entry of the `data-subagent-activity` part of its root tool call (see the chat-frame-translation capability). An entry holds the agent, the call path, the tool name, the one-line detail, the start and end times, and the outcome. It SHALL NOT hold a message, a tool input, or a tool output of the sub-agent. A frame of a sub-agent that names no root tool call, for example a frame of the compaction exchange, SHALL leave no record.

The recorder SHALL record each call's outcome and detail as the live surface received them, rather than leaving either to be recomputed later. A call SHALL be recorded `incomplete` when it is dispatched and overwritten with its real outcome when it finishes, so the record is honest at every instant and a turn ending mid-call needs no closing pass. Stamping an unfinished call a failure or a success would report something nothing produced. The same SHALL apply to an entry of a sub-agent call: an entry with no outcome when its round closes SHALL be stored `incomplete`, with no end time.

#### Scenario: Text and cards preserve their relative order

- **WHEN** a turn emits text, then a display card, then more text
- **THEN** the stored UI message contains those three visible parts in the same order

#### Scenario: Concurrent tool emissions preserve observed order

- **WHEN** concurrently executing tools emit display parts in an order different from tool-call declaration order
- **THEN** the stored UI message preserves the order observed by the shared recorder

#### Scenario: Approval reaches a terminal stored state

- **WHEN** `data-ask` is emitted pending and later re-emitted resolved or rejected under the same id
- **THEN** the stored UI message contains one approval part in the terminal state

#### Scenario: Sub-agent display is excluded

- **WHEN** a nested agent emits a display part that the top-level conversation surface filters
- **THEN** that part is absent from the stored top-level UI message

#### Scenario: The tool calls of a sub-agent are kept as entries

- **GIVEN** a root tool call `t1` that runs a sub-agent, and the sub-agent makes two tool calls
- **WHEN** the turn is stored and the transcript is loaded
- **THEN** the assistant message holds one `data-subagent-activity` part for `t1`, with one entry for each call of the sub-agent, and no entry holds text of the sub-agent

#### Scenario: A nested exchange with no root call leaves no record

- **WHEN** the compaction exchange of the turn makes a tool call
- **THEN** no stored part holds an entry for that call

#### Scenario: Calls finishing out of order keep their observed positions

- **WHEN** two concurrent calls start in one order and finish in the other
- **THEN** each stored part stays in the position its call first took

#### Scenario: An interrupted call is stored as incomplete, not as failed or succeeded

- **WHEN** a turn is interrupted while a call is in flight
- **THEN** the stored part reports the call `incomplete`, in the one field that carries its terminal state

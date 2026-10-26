## ADDED Requirements

### Requirement: A decoder line that is not complete JSON costs only its own readout
The input scan MUST skip a decoder output line that is not complete JSON. It MUST keep each readout that a complete line gives.

The sandbox keeps a bounded part of the decoder output, and a timeout can stop the decoder in the middle of a write. Thus the last line of the output can be cut. A cut line names no path that the scan can trust. A path that only a cut line names gets the reason from the outcome of the exec. A path that the decoder reported nothing for gets the same reason. When the sandbox cut the output at its byte cap, that reason MUST name the cut output.

#### Scenario: A cut last line keeps the readouts before it
- **GIVEN** a decoder output that holds two complete readout lines and then the start of a third line
- **WHEN** the scan reads the output
- **THEN** the paths of the two complete lines carry their readouts
- **AND** the scan gives a result, not an error

#### Scenario: A path that only the cut line names carries a reason
- **GIVEN** a decoder output whose only line for a path is cut
- **WHEN** the scan reads the output
- **THEN** that path carries a reason from the outcome of the exec

#### Scenario: A path lost to the output cap names the cut output
- **GIVEN** a decoder output that the sandbox cut at its byte cap, and a path that only the cut line names
- **WHEN** the scan reads the output
- **THEN** that path carries a reason that names the cut output

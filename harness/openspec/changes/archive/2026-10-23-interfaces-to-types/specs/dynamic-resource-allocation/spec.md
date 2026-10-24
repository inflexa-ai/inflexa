## MODIFIED Requirements

### Requirement: Resource type definitions

The system SHALL define the resource types as Zod schemas:

```typescript
type ResourceLimits = {
  maxCpu: number;       // positive
  maxMemoryGb: number;  // positive; camelCase "Gb"
  maxGpuCount: number;  // non-negative integer
}

type ResourceSpec = {
  cpu: number;          // positive
  memoryGb: number;     // positive
  gpu?: GpuSpec;
}

type GpuSpec = {
  count: number;        // positive integer; no "type" field
}
```

There is no `allowedGpuTypes` field on `ResourceLimits` and no `type` field on
`GpuSpec`.

#### Scenario: ResourceLimits validates

- **GIVEN** the `ResourceLimitsSchema`
- **WHEN** validating `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 1 }`
- **THEN** validation passes

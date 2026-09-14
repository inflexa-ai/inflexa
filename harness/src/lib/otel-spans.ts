/**
 * Span policy of the harness TracerProvider: which DBOS traces are recorded,
 * which spans reach the exporter, and the names the exported spans carry.
 *
 * DBOS names a workflow span after the registered workflow and a step span
 * after the step function, and it runs each body under its span, so every
 * child (a step, a patched fetch, a pg query) sits under the workflow span.
 * Three shapes of that output are noise in a trace store, and each is stopped
 * in the process, before export, rather than in a collector downstream. The
 * decisions live where the workflows and steps are written; this module holds
 * the mechanism only:
 *
 * - A module that registers a housekeeping workflow declares it untraced with
 *   `untracedWorkflow(name)` next to its registration. The sampler drops a
 *   root span that carries such a name at creation, and `ParentBased`
 *   sampling carries the decision to every child.
 * - A replayed step re-emits its span with `cached=true`, which DBOS sets
 *   after the span has started. A sampler cannot see that, so
 *   `DbosSpanProcessor` drops the span at `onEnd`.
 * - A step whose DBOS name embeds an id calls `stableSpan` as the first
 *   statement of its body. The helper renames the active DBOS span to the
 *   stable prefix and puts the id in an `inflexa.*` attribute. The DBOS step
 *   name itself is untouched: DBOS compares it against the recorded name on
 *   replay and throws `DBOSUnexpectedStepError` on a mismatch, so a rename
 *   would break every workflow in flight across a deploy.
 */

import { trace, type Attributes, type Context } from "@opentelemetry/api";
import {
    ParentBasedSampler,
    SamplingDecision,
    type ReadableSpan,
    type Sampler,
    type SamplingResult,
    type Span,
    type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * Names of the DBOS workflows whose traces are not recorded. A registering
 * module adds its own name at registration, which runs at boot inside
 * `assembleCoreRuntime`, before `DBOS.launch` starts the first workflow. The
 * sampler reads the set on every root span, so the set is complete before it
 * is consulted, and a name added later applies from the next root span on.
 */
const untracedWorkflowNames = new Set<string>();

/**
 * Declare a registered DBOS workflow untraced: no root span for it is
 * recorded, and no child span under it. Call it next to the
 * `DBOS.registerWorkflow` that gives the workflow the same name.
 */
export function untracedWorkflow(name: string): void {
    untracedWorkflowNames.add(name);
}

/** Root decision only: `NOT_RECORD` for an untraced workflow, `RECORD_AND_SAMPLED` for every other root. */
class UntracedWorkflowRootSampler implements Sampler {
    shouldSample(_context: Context, _traceId: string, spanName: string): SamplingResult {
        return {
            decision: untracedWorkflowNames.has(spanName) ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
        };
    }

    toString(): string {
        return "UntracedWorkflowRootSampler";
    }
}

/**
 * The sampler of the harness TracerProvider. A root span named after an
 * untraced workflow is not recorded; every other root is. A span with a parent
 * takes the parent's decision (the standard `ParentBased` behaviour), so a DBOS
 * step, a fetch, or a pg span under a dropped root is dropped with it, and a
 * remote parent (an inbound `traceparent`) is honoured as usual.
 */
export function createHarnessSampler(): Sampler {
    return new ParentBasedSampler({ root: new UntracedWorkflowRootSampler() });
}

/** The plan step id a `compose-step-seed` step carries. */
export const ATTR_INFLEXA_STEP_ID = "inflexa.step_id";
/** The provider tool-use id of a tool step. */
export const ATTR_INFLEXA_TOOL_USE_ID = "inflexa.tool_use_id";
/** The exec id (`${workflowId}:${stepId}:${fnId}`) of a sandbox exec step. */
export const ATTR_INFLEXA_EXEC_ID = "inflexa.exec_id";
/** The 1-based attempt counter of a sandbox poll, pull, or liveness-probe step. */
export const ATTR_INFLEXA_ATTEMPT = "inflexa.attempt";
/** The per-item key (a ChEMBL or NCT id) of a target-assessment fan-out step. */
export const ATTR_INFLEXA_FANOUT_KEY = "inflexa.fanout_key";

/**
 * Rename the DBOS span of the step that is running to `name` and put its id
 * in `attributes`. Call it as the first statement of a step body whose DBOS
 * name embeds an id, with that DBOS name as `dbosName`.
 *
 * DBOS runs the body under its span, so with tracing on the active span is
 * the step span. With tracing off DBOS opens no span, and the active span, if
 * there is one, belongs to whoever started the workflow or the chat turn. The
 * helper therefore renames a span only when its name is `dbosName`, and it
 * leaves a missing or non-recording span alone.
 */
export function stableSpan(dbosName: string, name: string, attributes: Attributes): void {
    const span = trace.getActiveSpan();
    if (span === undefined || !span.isRecording()) return;
    // The API `Span` has no name accessor; the SDK span the provider hands out does.
    if ((span as Partial<ReadableSpan>).name !== dbosName) return;
    span.updateName(name);
    span.setAttributes(attributes);
}

/**
 * Sits in front of the exporting processor and forwards every span except a
 * replayed one (`cached=true`), which it drops at `onEnd`.
 */
export class DbosSpanProcessor implements SpanProcessor {
    constructor(private readonly next: SpanProcessor) {}

    onStart(span: Span, parentContext: Context): void {
        this.next.onStart(span, parentContext);
    }

    onEnding(span: Span): void {
        this.next.onEnding?.(span);
    }

    onEnd(span: ReadableSpan): void {
        if (span.attributes.cached === true) return;
        this.next.onEnd(span);
    }

    forceFlush(): Promise<void> {
        return this.next.forceFlush();
    }

    shutdown(): Promise<void> {
        return this.next.shutdown();
    }
}

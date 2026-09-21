/**
 * The labels of a sandbox, the same on the Docker backend and on the K8s
 * backend (sandbox-labels spec).
 *
 * The harness label set names the sandbox and the work that spawned it:
 *
 *   app.kubernetes.io/managed-by  cortex
 *   role                          sandbox
 *   cortex/sandbox-id             the sandbox id, `sbx-{run8}-{rand8}`
 *   cortex/analysis-id            session.scope.analysisId
 *   cortex/run-id                 session.runFrame.runId
 *   cortex/step-id                session.runFrame.stepId
 *
 * Each harness value is a valid K8s label value by construction: 1 to 63
 * characters, `[A-Za-z0-9._-]` only, a letter or a digit at each end. A run id
 * is a UUID or a short literal of the harness, a step id obeys the step-id rule
 * of the plan validator, and the harness makes the sandbox id. The analysis id
 * comes from the host, thus on K8s the host must give one that is a valid
 * label value.
 *
 * The host labels merge first and the harness labels last, thus a harness key
 * wins a clash. The harness stamps each host value as the host gives it and
 * changes no value: a host reconciler uses a label value as a lookup key, and
 * a changed value cannot find its record. On K8s the API server does a check of
 * each value at admission, and it is the authority.
 */

import type { SpawnSession } from "../auth/types.js";
import type { SandboxLabels } from "./types.js";

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY_VALUE = "cortex";
export const SANDBOX_ID_LABEL = "cortex/sandbox-id";
export const ANALYSIS_ID_LABEL = "cortex/analysis-id";
export const RUN_ID_LABEL = "cortex/run-id";
export const STEP_ID_LABEL = "cortex/step-id";

/**
 * The key of the owner workflow id. A Docker label value has no limit, thus
 * Docker keeps the id as a label. A DBOS workflow id can be longer than 63
 * characters and can hold `:`, thus K8s keeps it as a Job annotation.
 */
export const OWNER_WORKFLOW_KEY = "cortex/owner-workflow-id";

/** A valid K8s label value: 1 to 63 characters, `[A-Za-z0-9._-]` only, a letter or a digit at each end. */
const LABEL_VALUE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * True when `value` is a valid K8s label value. The plan validator applies it
 * to each step id, because the harness stamps a step id as a label value with
 * no change. The harness never applies it to a host value.
 */
export function isLabelValue(value: string): boolean {
    return LABEL_VALUE.test(value);
}

/** The harness label set of one sandbox. */
export function harnessLabels(session: SpawnSession, sandboxId: string): Record<string, string> {
    return {
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        role: "sandbox",
        [SANDBOX_ID_LABEL]: sandboxId,
        [ANALYSIS_ID_LABEL]: session.scope.analysisId,
        [RUN_ID_LABEL]: session.runFrame.runId,
        [STEP_ID_LABEL]: session.runFrame.stepId,
    };
}

/** The labels of a sandbox: the host labels first, the harness labels last. No value changes. */
export function mergeLabels(hostLabels: SandboxLabels, harness: Readonly<Record<string, string>>): Record<string, string> {
    return { ...hostLabels, ...harness };
}

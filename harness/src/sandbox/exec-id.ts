/**
 * `execId` parsing — execId is `${workflowId}:${stepId}:${fnId}` where the
 * workflowId portion itself contains exactly one colon (child workflow ids
 * are `${analysisId}:${runId}-${stepIdx}`, parent ids are
 * `${analysisId}:${runId}`). `indexOf(":")` / `split(":")[0]` over an
 * execId would stop INSIDE the workflowId and return only the analysisId,
 * which `DBOS.send` would treat as a wrong-workflow target. Strip the last
 * two colon-delimited segments (`:${stepId}:${fnId}`) to recover the
 * workflowId. `stepId` is a plan-defined slug and `fnId` is `fn-${n.toString(36)}`,
 * neither of which can contain colons.
 */

export function workflowIdFromExec(execId: string): string | null {
    const lastColon = execId.lastIndexOf(":");
    if (lastColon <= 0) return null;
    const secondLastColon = execId.lastIndexOf(":", lastColon - 1);
    if (secondLastColon <= 0) return null;
    return execId.slice(0, secondLastColon);
}

/**
 * The SQL write shapes that the workflow tests match on recorded queries. The
 * templates of the body wrap their SQL across lines, so each shape carries the
 * flexible whitespace of that wrapping. One matcher per write, named for the
 * write it finds.
 */

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the suspend write that the body inlines, across wrapped SQL lines
export const SUSPEND_STATE_WRITE = /UPDATE\s+cortex_analysis_state\s+SET\s+status\s*=\s*'suspended_insufficient_funds'/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the run status write, across wrapped SQL lines
export const RUNS_STATUS_WRITE = /UPDATE cortex_runs\s+SET status/;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the run status write in any letter case, across wrapped SQL lines
export const RUNS_STATUS_WRITE_ANY_CASE = /UPDATE\s+cortex_runs\s+SET\s+status/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the synthesis status write on the run row, across wrapped SQL lines
export const SYNTHESIS_STATUS_WRITE = /UPDATE\s+cortex_runs\s+SET\s+synthesis_status/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the seed insert of the step ledger, across wrapped SQL lines
export const STEP_SEED_INSERT = /INSERT INTO cortex_step_executions/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the conflict arm of the seed insert, across wrapped SQL lines
export const ON_CONFLICT_DO_NOTHING = /DO NOTHING/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the conflict arm of the mark-running upsert, across wrapped SQL lines
export const ON_CONFLICT_DO_UPDATE = /DO UPDATE/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the parameterized terminal status write on the step ledger, across wrapped SQL lines
export const STEP_STATUS_WRITE_PARAM = /UPDATE cortex_step_executions\s+SET status = \$1/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the terminal sweep of pending steps to skipped, across wrapped SQL lines
export const SKIPPED_SWEEP_WRITE = /UPDATE cortex_step_executions\s+SET status = 'skipped'/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the parameterized run status write, across wrapped SQL lines
export const RUN_STATUS_WRITE_PARAM = /UPDATE cortex_runs\s+SET status = \$1/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the step-ledger update that marks a canceled step, across wrapped SQL lines
export const STEP_EXECUTIONS_UPDATE = /UPDATE\s+cortex_step_executions/i;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the parts write on the run row, across wrapped SQL lines
export const RUNS_PARTS_WRITE = /UPDATE\s+cortex_runs\s+SET\s+parts/i;

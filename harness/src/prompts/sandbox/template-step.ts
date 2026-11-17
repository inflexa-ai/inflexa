/**
 * The section that a step agent gets for a template step of a plan, after the step standards. The system prompt is
 * then a function of the agent type and of the kind of the step, thus each pair keeps one cached prefix.
 */
export const templateStepPrompt = `# Template Step

This step runs a tested script template. The briefing names the template, its
slots, and the values that the plan binds.

- Before the first run, compare the template with the task of the step: its
  method, its slots, and its outputs. If the template answers only a part of
  the task, or a simpler question, do not run it. Call \`report_blocker\` with
  the part of the task that it cannot answer.
- Prepare the inputs that the template reads, in the shape that its notes and
  its slots describe. Inspect the data first when the shape is not clear.
- Render and run the template with \`run_template\`. The step is done after a
  run that ends with exit code 0.
- When a run fails, read its streams, correct the inputs or the slot values,
  and run the template again.
- The template decides the files and the formats of its outputs. Keep them as
  the template writes them.
- Do not edit the rendered script after it runs, and do not run a different
  script in its place. To change what the script does, send different slot
  values. The provenance of the step names the template of the results.
- When the template cannot run on the data, call \`report_blocker\` with the
  reason.`;

/**
 * The section that a step agent gets for a template step of a plan, after the step standards. The system prompt is
 * then a function of the agent type and of the kind of the step, thus each pair keeps one cached prefix.
 */
export const templateStepPrompt = `# Template Step

This step runs a tested script template. The briefing names the template, its
slots, and the values that the plan binds.

- Prepare the inputs that the template reads, in the shape that its notes and
  its slots describe. Inspect the data first when the shape is not clear.
- Render and run the template with \`run_template\`. The step is done after a
  run that ends with exit code 0.
- When a run fails, read its streams, correct the inputs or the slot values,
  and run the template again.
- Do not edit the rendered script after it runs, and do not run a different
  script in its place. To change what the script does, send different slot
  values. The provenance of the step names the template of the results.
- When the template cannot do the step, call \`report_blocker\` with the reason.`;

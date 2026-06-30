export function stepSummaryPrompt(artifactList: string): string {
    const artifacts = artifactList.trim().length > 0 ? artifactList : "(none — this step produced no output files)";
    return `Summarize the analysis you just completed as a markdown document.
Your full execution history — tool calls, code output, intermediate
results — is in your conversation context above. Use it for narrative and
intent, but ground every quantitative claim in a persisted output file.

Output files produced:
${artifacts}

Use the read_file tool to open any output file whose contents you need to
report a number. A number that appears only in command stdout is NOT
sufficient — read the persisted artifact that holds it and report what the
file actually contains. Relative paths resolve against this step's output
directory; you may also read input data, the data profile, or prior-run
outputs by absolute path if needed for context.

Write a markdown summary that covers:
- key quantitative results — every number lifted from a persisted output
  file you read with read_file
- method choices and their rationale
- quality notes (sample size, assumptions, caveats)
- limitations of the analysis

Use markdown headings and bullets freely — there is no fixed schema.
Report only numbers that exist in a persisted artifact. Do not fabricate
results and do not report a number that appears only in command stdout.

If there are no output files, say so plainly — state that the step produced
no output files and summarize only what the execution history shows was
attempted. Do NOT synthesize results that no artifact backs.

Output ONLY the summary markdown. Do not include any preamble, meta-commentary,
apologies, or remarks about tool availability, file access, or your environment.
If a specific number is not visible in any persisted artifact, omit it — do not
explain why it is missing.
`;
}

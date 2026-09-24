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
file actually contains. Relative paths resolve against this step's working
directory, as they did during the step; you may also read input data or
prior-run outputs by absolute path if needed for context.

Write a markdown summary that covers:
- key quantitative results — every number lifted from a persisted output
  file you read with read_file
- method choices and their rationale
- quality notes (sample size, assumptions, caveats)
- limitations of the analysis

Use markdown headings and bullets freely — there is no fixed schema.
Match the length to what the step found: cover the substance, but do not
pad the summary with filler sections, restated context, or boilerplate. A
downstream step first sees only the opening of your summary, so put the
key results first.

If there are no output files, say so plainly — state that the step produced
no output files and summarize only what the execution history shows was
attempted. Do NOT synthesize results that no artifact backs.

Your reply is stored as the step summary exactly as you write it, so it holds
the summary alone. If a specific number is not visible in any persisted
artifact, omit it — do not explain why it is missing.
`;
}

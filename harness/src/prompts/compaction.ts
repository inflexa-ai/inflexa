import { COMPACTION_MAX_REQUESTS } from "../loop/compaction.js";

/** The compaction request of a thread whose agent maintains the working memory. */
export const MEMORY_COMPACTION_REQUEST = `The conversation is too long for the context window. The harness replaces the conversation above with your summary.

First, move each lasting fact into the working memory with update_working_memory: the goal, each constraint, each hypothesis, and each finding with its run id. Keep each constraint that the user gave as it is, because the user set it. No other tool can run now. Send all the memory edits in at most ${COMPACTION_MAX_REQUESTS - 1} replies, and put many calls in one reply. The reply after the edits must be the summary: if it calls a tool, the harness gets no summary.

Then reply in plain text with the summary. Leave out each fact that a memory edit accepted. If the memory refused an edit, put that fact in the summary. Give:
- the current request of the user in its exact words
- the decisions, with their reasons
- the approaches that failed or that the user ruled out, with the reasons
- the open questions
- the file paths, the run ids, and the other exact values that the work uses
- the state of the work in progress

The conversation continues from your summary, the working memory, and the messages after them.`;

/** The compaction request of a thread that reads a frozen copy of the working memory, for example a report thread. */
export const SUMMARY_COMPACTION_REQUEST = `The conversation is too long for the context window. The harness replaces the conversation above with your summary. No tool can run now.

Reply in plain text with the summary. Leave out what the working memory holds. Give:
- the goals, and the current request of the user in its exact words
- each change that the user made to the brief
- the decisions, with their reasons
- the approaches that failed or that the user ruled out, with the reasons
- the open questions
- the file paths, the run ids, and the other exact values that the work uses
- the state of the work in progress

The conversation continues from your summary, the working memory, and the messages after them.`;

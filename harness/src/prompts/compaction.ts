/** The compaction request of a thread whose agent maintains the working memory. */
export const MEMORY_COMPACTION_REQUEST = `The conversation is too long for the context window. The harness replaces the conversation above with your summary.

First, move each lasting fact into the working memory with update_working_memory: the goal, each constraint, each hypothesis, and each finding with its run id. No other tool can run now.

Then reply in plain text with the summary. Leave out what the working memory holds. Give:
- the goals, and the current request of the user in its exact words
- the decisions, with their reasons
- the open questions
- the file paths and the run ids that the work uses
- the state of the work in progress

The conversation continues from your summary, the working memory, and the messages after them.`;

/** The compaction request of a thread that reads a frozen copy of the working memory, for example a report thread. */
export const SUMMARY_COMPACTION_REQUEST = `The conversation is too long for the context window. The harness replaces the conversation above with your summary. No tool can run now.

Reply in plain text with the summary. Leave out what the working memory holds. Give:
- the goals, and the current request of the user in its exact words
- the decisions, with their reasons
- the open questions
- the file paths and the run ids that the work uses
- the state of the work in progress

The conversation continues from your summary, the working memory, and the messages after them.`;

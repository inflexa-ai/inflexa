import type { EvalCase } from "../lib/case.js";
import { analogyCases } from "./analogy.js";
import { cliHostToolCases } from "./cli-host-tools.js";
import { conversationCases } from "./conversation.js";
import { plannerCases } from "./planner.js";
import { reportCases } from "./report.js";
import { sandboxCases } from "./sandbox.js";
import { synthesisCases } from "./synthesis.js";

/** Each case of the suite. An id is unique across the files. */
export const allCases: readonly EvalCase[] = [
    ...conversationCases,
    ...cliHostToolCases,
    ...plannerCases,
    ...reportCases,
    ...analogyCases,
    ...synthesisCases,
    ...sandboxCases,
];

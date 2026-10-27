import type { EvalCase } from "../lib/case.js";
import { cliHostToolCases } from "./cli-host-tools.js";
import { conversationCases } from "./conversation.js";

/** Each case of the suite. An id is unique across the files. */
export const allCases: readonly EvalCase[] = [...conversationCases, ...cliHostToolCases];

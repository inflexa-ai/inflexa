import type { ChatMessage, TokenUsageRollup } from "@inflexa-ai/harness/contracts/index.js";
import type { AskReply as HarnessAskReply } from "@inflexa-ai/harness/tools/approval/contract.js";
import type { PendingAsk as HarnessPendingAsk } from "@inflexa-ai/harness/tools/approval/queries.js";

import type { ListEnvelope } from "./common.ts";

// The wire types of the conversation routes (draft 2.3): threads, turns, and asks. Each harness type here is
// a type-only import of the file that defines it, because the root barrel of the harness loads its runtime.

/** The kind of session that a thread holds. */
export type ThreadType = "conversation" | "report";

/** A thread on the wire: the Cortex `ThreadPayload`, plus `archivedAt`. An absent optional value omits its key. */
export type ThreadSummary = {
    id: string;
    /** The harness seeds it from the first user message, thus a new thread can have none. */
    title?: string;
    /** The analysis id. The name is the Cortex name. */
    resourceId: string;
    threadType: ThreadType;
    /** The conversation that a report thread was spawned from. */
    parentThreadId?: string;
    /** The `messages.seq` of the parent at the spawn. It is present exactly when `parentThreadId` is. */
    parentSeq?: number;
    createdAt: string;
    /** The last activity of the thread. An archive and a restore do not change it. */
    updatedAt: string;
    /** When the thread left view. Only a list with `includeArchived=true` gives an archived thread. */
    archivedAt?: string;
};

/** The body of `GET {A}/threads`: the most recently active first. */
export type ThreadList = ListEnvelope<"threads", ThreadSummary>;

/** The body of `PATCH {T}`. The server trims the title, and refuses a blank one. */
export type UpdateThreadRequest = {
    title: string;
};

/** The body of `DELETE {T}`. The archive keeps each row and each message. */
export type DeletedThread = {
    deleted: true;
};

/** The body of `POST {T}/purge`: keep or remove the report page folders of each erased thread. */
export type PurgeThreadRequest = {
    files: "keep" | "remove";
};

/**
 * What became of the report page folders of the erased threads. A folder that stayed is not a failed purge,
 * because the rows are gone. `unlocatable`: the workspace of the analysis did not resolve. `stayed` names each
 * folder that is still on disk, and its list is empty when an id gave no safe folder name.
 */
export type ReportPageFate = { kind: "kept" } | { kind: "removed" } | { kind: "unlocatable" } | { kind: "stayed"; dirs: string[] };

/** The body of `POST {T}/purge`. */
export type PurgedThread = {
    /** The id of each erased thread: the named one and each descendant. */
    purged: string[];
    pages: ReportPageFate;
};

/** The body of `GET {T}/messages`: the whole transcript. `total` counts the turns, and the paging fields are fixed, as in Cortex. */
export type MessageList = ListEnvelope<"messages", ChatMessage>;

/** The body of `POST {A}/chat`. */
export type ChatRequest = {
    threadId: string;
    message: string;
};

/** The response header of `POST {A}/chat` that names the turn. */
export const TURN_ID_HEADER = "Inflexa-Turn-Id";

/** The state of a turn. Each status except `running` is final. */
export type TurnStatus = "running" | "done" | "filtered" | "aborted" | "failed";

/** The credential state of the model proxy, read after a failed turn in `cliproxy` mode. */
export type CredentialVerdictView = { kind: "login_dead" } | { kind: "rate_limited"; retryAt: string } | { kind: "unknown" };

/** Why a turn did not answer. */
export type TurnFailure = {
    /** One line for a person, with the remedy when the server knows one. */
    message: string;
    /** A stable code, for example `content_filter`. */
    reason?: string;
    /** The detail lines of the cause, for a details view. */
    detailLines: string[];
    /** The provider refused the credential. `envVar` names the key variable of a `direct` connection. */
    auth?: { provider: string; envVar?: string };
    credential?: CredentialVerdictView;
};

/** One turn, as the turn registry of the server holds it. */
export type TurnSummary = {
    turnId: string;
    threadId: string;
    analysisId: string;
    status: TurnStatus;
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    /** True when the opening of the turn landed on the thread, thus a retract has a turn to remove. */
    opened?: boolean;
    turnUsage?: TokenUsageRollup;
    /** The final assistant text of a turn that ended, for a client that saw no text stream. */
    fallbackText?: string;
    /** True when some rows of the turn or its close did not land. */
    storeFailed?: boolean;
    /** Set for a `failed` and for a `filtered` turn. */
    failure?: TurnFailure;
};

/** The body of `GET {T}/turns`: the turns that run, then the ended turns that the server still holds, newest first. */
export type TurnList = ListEnvelope<"turns", TurnSummary>;

/** The body of `POST {T}/turns/:turnId/abort`. */
export type AbortTurnResponse = {
    turnId: string;
    outcome: "aborting" | "already_ended";
};

/** The body of `POST {T}/retract`. With `ifOrphan`, the server removes the tail turn only when it has no assistant row. */
export type RetractRequest = {
    ifOrphan?: boolean;
};

/** The body of `POST {T}/retract`. `not-orphaned`: the tail turn has an answer, thus `ifOrphan` removed nothing. */
export type RetractResponse = { kind: "retracted"; messages: number } | { kind: "empty-thread" } | { kind: "no-user-turn" } | { kind: "not-orphaned" };

/** The body of `POST {A}/asks/:askId/answer`: the harness `AskReply`. A reject feedback has a maximum of 2000 characters. */
export type AskReply = HarnessAskReply;

/** A pending ask: the harness `PendingAsk`. Its `createdAt` is ISO 8601. */
export type PendingAsk = HarnessPendingAsk;

/** The body of `GET {A}/asks`: the pending asks of the analysis, oldest first. */
export type AskList = ListEnvelope<"asks", PendingAsk>;

/** The body of `POST {A}/asks/:askId/answer`. */
export type AnswerAskResponse = {
    applied: true;
};

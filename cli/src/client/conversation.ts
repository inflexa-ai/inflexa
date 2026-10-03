import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import type { ChatFrame } from "@inflexa-ai/harness/contracts/index.js";

import type { PageQuery } from "../api/common.ts";
import {
    TURN_ID_HEADER,
    type AbortTurnResponse,
    type AnswerAskResponse,
    type AskList,
    type AskReply,
    type ChatRequest,
    type DeletedThread,
    type MessageList,
    type PurgedThread,
    type PurgeThreadRequest,
    type RetractRequest,
    type RetractResponse,
    type ThreadList,
    type ThreadSummary,
    type ThreadType,
    type TurnList,
    type TurnSummary,
    type UpdateThreadRequest,
} from "../api/conversation.ts";
import { DEFAULT_CLIENT_OPTS, openStream, request, type ClientError, type ClientOpts } from "./api.ts";

function analysisPath(analysisId: string): string {
    return `/api/v1/analyses/${encodeURIComponent(analysisId)}`;
}

function threadPath(analysisId: string, threadId: string): string {
    return `${analysisPath(analysisId)}/threads/${encodeURIComponent(threadId)}`;
}

function pageParams(page: PageQuery): URLSearchParams {
    return new URLSearchParams({ page: String(page.page), perPage: String(page.perPage) });
}

/** The filters of `GET {A}/threads`. Each one that is absent narrows nothing. */
export type ThreadQuery = {
    readonly type?: ThreadType;
    readonly parentThreadId?: string;
    /** Add the archived threads to the live ones. */
    readonly includeArchived?: boolean;
};

/** `GET {A}/threads`: one page of the threads of an analysis, the most recently active first. */
export function fetchThreads(
    analysisId: string,
    query: ThreadQuery,
    page: PageQuery,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<ThreadList, ClientError> {
    const params = pageParams(page);
    if (query.type !== undefined) params.set("type", query.type);
    if (query.parentThreadId !== undefined) params.set("parentThreadId", query.parentThreadId);
    if (query.includeArchived === true) params.set("includeArchived", "true");
    return request<ThreadList>("GET", `${analysisPath(analysisId)}/threads?${params.toString()}`, {}, opts);
}

/**
 * `GET {T}`: one live thread, or `null` when it is absent, archived, or of a different analysis (404). A
 * thread with no row is a normal state: a new conversation has an id before its first turn writes the row.
 */
export function fetchThread(analysisId: string, threadId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ThreadSummary | null, ClientError> {
    return request<ThreadSummary>("GET", threadPath(analysisId, threadId), {}, opts)
        .map((thread): ThreadSummary | null => thread)
        .orElse((e) => (e.type === "http" && e.status === 404 ? okAsync(null) : errAsync(e)));
}

/** `PATCH {T}`: rename a thread. 404 `not_found` when the thread is gone. */
export function updateThread(
    analysisId: string,
    threadId: string,
    body: UpdateThreadRequest,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<ThreadSummary, ClientError> {
    return request<ThreadSummary>("PATCH", threadPath(analysisId, threadId), { body }, opts);
}

/** `DELETE {T}`: archive a thread and its subtree. The rows and the messages stay. */
export function deleteThread(analysisId: string, threadId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<DeletedThread, ClientError> {
    return request<DeletedThread>("DELETE", threadPath(analysisId, threadId), {}, opts);
}

/** `POST {T}/restore`: bring one archived thread back to view. */
export function restoreThread(analysisId: string, threadId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ThreadSummary, ClientError> {
    return request<ThreadSummary>("POST", `${threadPath(analysisId, threadId)}/restore`, {}, opts);
}

/** `POST {T}/purge`: erase a thread and its subtree, and keep or remove their report page folders. */
export function purgeThread(
    analysisId: string,
    threadId: string,
    body: PurgeThreadRequest,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<PurgedThread, ClientError> {
    return request<PurgedThread>("POST", `${threadPath(analysisId, threadId)}/purge`, { body }, opts);
}

/** `GET {T}/messages`: the whole transcript. 404 `not_found` for a thread with no row. */
export function fetchMessages(analysisId: string, threadId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<MessageList, ClientError> {
    return request<MessageList>("GET", `${threadPath(analysisId, threadId)}/messages`, {}, opts);
}

/** `POST {T}/retract`: remove the tail turn. With `ifOrphan`, only a tail turn with no assistant row. */
export function retractTurn(
    analysisId: string,
    threadId: string,
    body: RetractRequest,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<RetractResponse, ClientError> {
    return request<RetractResponse>("POST", `${threadPath(analysisId, threadId)}/retract`, { body }, opts);
}

/** `GET {T}/turns`: the turns that run on the thread, then the ended turns that the server still holds. */
export function fetchTurns(analysisId: string, threadId: string, page: PageQuery, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<TurnList, ClientError> {
    return request<TurnList>("GET", `${threadPath(analysisId, threadId)}/turns?${pageParams(page).toString()}`, {}, opts);
}

/** `GET {T}/turns/:turnId`: the state and the outcome of one turn. 404 `not_found` for a turn that the server forgot. */
export function fetchTurn(analysisId: string, threadId: string, turnId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<TurnSummary, ClientError> {
    return request<TurnSummary>("GET", `${threadPath(analysisId, threadId)}/turns/${encodeURIComponent(turnId)}`, {}, opts);
}

/** `POST {T}/turns/:turnId/abort`: stop a turn. Any client can send it. */
export function abortTurn(
    analysisId: string,
    threadId: string,
    turnId: string,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<AbortTurnResponse, ClientError> {
    return request<AbortTurnResponse>("POST", `${threadPath(analysisId, threadId)}/turns/${encodeURIComponent(turnId)}/abort`, {}, opts);
}

/** A chat turn that the server started: its id, and its frames as they arrive. */
export type ChatTurnStream = {
    readonly turnId: string;
    readonly frames: AsyncGenerator<Result<ChatFrame, ClientError>>;
};

/**
 * `POST {A}/chat`: run one turn, and give its stream. A refusal before the turn opens is an error: 404
 * `not_found` for a thread of a different analysis, 500 for a turn that could not start. The stream ends after
 * its one `finish` or `error` frame. The turn does not stop when the stream is dropped: send the abort for that.
 */
export function createChatTurn(analysisId: string, body: ChatRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ChatTurnStream, ClientError> {
    return openStream<ChatFrame>("POST", `${analysisPath(analysisId)}/chat`, { body }, opts).andThen((stream) => {
        const turnId = stream.headers.get(TURN_ID_HEADER);
        if (turnId === null) {
            void stream.frames.return(undefined);
            return errAsync<ChatTurnStream, ClientError>({ type: "bad_json", status: 200, detail: `the chat stream has no ${TURN_ID_HEADER} header` });
        }
        return okAsync({ turnId, frames: stream.frames });
    });
}

/** `GET {A}/asks`: the pending asks of an analysis. */
export function fetchAsks(analysisId: string, page: PageQuery, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AskList, ClientError> {
    return request<AskList>("GET", `${analysisPath(analysisId)}/asks?${pageParams(page).toString()}`, {}, opts);
}

/** `POST {A}/asks/:askId/answer`: answer an ask. 404 `not_found` for an unknown ask, 409 `conflict` for an ask that is already answered. */
export function answerAsk(
    analysisId: string,
    askId: string,
    reply: AskReply,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<AnswerAskResponse, ClientError> {
    return request<AnswerAskResponse>("POST", `${analysisPath(analysisId)}/asks/${encodeURIComponent(askId)}/answer`, { body: reply }, opts);
}

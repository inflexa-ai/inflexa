## 1. Conversation store (`src/tui/hooks/conversation.ts`)

- [x] 1.1 Create the module singleton mirroring `status.ts`: move the `UIMessage` type, the `messages` `createStore`, and the `streamText`/`streamPartId`/`errorMsg` signals out of `app.tsx`
- [x] 1.2 Export `messageCount(): number` accessor and `errorMsg` accessor + `setError(msg: string | null)`
- [x] 1.3 Move `loadMessages(sessionId)` (app.tsx:60-75) here; on db error call `setError` + `setChatStatus("error")`
- [x] 1.4 Move the bus reducer (app.tsx:117-191) here as `applyBusEvent(event: BusEvent, sessionId: string)` — filter by the passed `sessionId`, keep the `produce` mutations and the `setChatStatus` calls verbatim
- [x] 1.5 Add `resetHotState()`: abort the in-flight request, clear `messages`, `streamText`, `streamPartId`, `errorMsg`, and set `chatStatus` idle
- [x] 1.6 Add the request lifecycle: a module-private `AbortController | null`, `send({ sessionId, userText })` that creates the controller and calls `chat()` from `modules/intelligence/chat.ts` (mapping its error result to `setError` + `setChatStatus("error")`), and `abort()`

## 2. Chat component (`src/tui/components/chat.tsx`)

- [x] 2.1 Create the `Chat` Solid component; `useWorkspace()` for the reactive `sessionId`
- [x] 2.2 Subscribe the bus in `onMount` → `applyBusEvent(e, ws.sessionId)`, with `onCleanup(() => Bus.off(...))`
- [x] 2.3 Add `createEffect(on(() => ws.sessionId, (sid, prev) => { if (prev !== undefined) resetHotState(); loadMessages(sid); }))` so first run loads and later changes reset+reload
- [x] 2.4 Render the scrollbox (app.tsx:313-322) + empty-state + `<For>`/`MessageBlock`, then the error banner (app.tsx:325-329) reading `errorMsg()`

## 3. Thin `src/tui/app.tsx`

- [x] 3.1 Remove the conversation store, the stream/error signals, `loadMessages`, the reducer, the `onMount` subscription, and the `UIMessage` type
- [x] 3.2 Replace the scrollbox + banner JSX with `<Chat />` in the chat column
- [x] 3.3 Source `<Sidebar messageCount={messageCount} />` from the conversation store
- [x] 3.4 Reduce `handleSubmit` to: textarea read/clear, `/quit` check, `conversation.send({ sessionId: workspace.sessionId, userText: text })`; on its error use `setError`/`setChatStatus`
- [x] 3.5 Point the abort keybinding (app.tsx:205-209) at `conversation.abort()`
- [x] 3.6 Remove the `onOpenSession` reset block from the `createWorkspace` init (app.tsx:103-111)

## 4. Drop the workspace reset seam (`src/tui/contexts/workspace.ts`)

- [x] 4.1 Remove `onOpenSession` from `WorkspaceInit` and its invocation in `createWorkspace` (workspace.ts:50-51, 76); update the JSDoc that describes the host-reset seam
- [x] 4.2 Confirm `openSession` remains the sole writer of the scope (sets the four data fields only)

## 5. Verify

- [x] 5.1 `grep -n "createStore\|streamText\|applyBusEvent\|loadMessages" src/tui/app.tsx` shows the conversation state is gone from `app.tsx`
- [x] 5.2 `bun run typecheck` passes
- [x] 5.3 `bun run lint` passes (no `forEach`, props not destructured, bus subscription paired with cleanup)
- [x] 5.4 `bun run format:file` on all created/edited `src/` files
- [x] 5.5 Manual smoke: send a message (streams + persists), trigger an error, switch sessions mid-stream (aborts + reloads), and confirm the sidebar message count updates live

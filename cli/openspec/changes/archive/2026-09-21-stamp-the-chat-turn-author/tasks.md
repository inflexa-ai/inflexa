# Tasks

## 1. The identity read

- [x] 1.1 Read `node_modules/@inflexa-ai/harness/dist/memory/thread-history.d.ts` and make sure that `ConversationTurn` declares `author`. Do not build the harness and do not edit it
- [x] 1.2 Add `currentUserEmail(): string | null` to `src/modules/auth/whoami.ts`. Give it a JSDoc block that states why an absence is not an error. Make sure that `bun run typecheck` passes
- [x] 1.3 Add a case to `src/modules/prov/prov.test.ts` that pins the two branches of `currentUserActor`: a stored session with an email gives the user actor with that id and email, and no stored session gives the anonymous actor. Write it BEFORE the edit of 1.4, and make sure that it passes against the code of today
- [x] 1.4 Change `currentUserActor` (`src/modules/prov/prov.ts`) to call `currentUserEmail`, and keep its actor shape and its anonymous branch. Make sure that the case of 1.3 still passes

## 2. The stamp at the append

- [x] 2.1 Add the required member `readAuthor: () => string | null` to `ChatTurnSeams` (`src/modules/harness/turn.ts`), and bind it to `currentUserEmail` in `realTurnSeams`
- [x] 2.2 Call `readAuthor` in `runChatTurn` at the top of the turn, before `seams.prepare`, and hold the value for the append. Comment why the read happens there and not at the append
- [x] 2.3 Spread `author` onto the `appendTurn` payload only for a non-empty string. Comment why the engine keeps that guard although the read gives `null` for an empty claim
- [x] 2.4 Give `readAuthor: () => null` to each other site that builds the bag literally: `src/tui/hooks/conversation.usage_recorder.test.ts` (two sites), `src/modules/harness/usage_ledger.test.ts`, and `src/modules/harness/agent_switch.test.ts`
- [x] 2.5 Make sure that neither `src/tui/hooks/conversation.ts` nor `src/modules/harness/dev/chat.ts` passes a new argument, and that `bun run typecheck` passes

## 3. The cases of the identity read

- [x] 3.1 Add a case to `src/modules/auth/auth.test.ts`: with no stored session, `currentUserEmail` gives `null`
- [x] 3.2 Add a case: with a stored session whose token holds an email, it gives that email
- [x] 3.3 Add a case: with a stored session whose token holds no email, and one whose token does not decode, it gives `null`
- [x] 3.4 Add a case: with a stored session whose email claim is empty, it gives `null`
- [x] 3.5 Add a case: with a stored session file that the schema refuses, it gives `null`. That case covers each error of `loadAuth`, because one error channel carries them all
- [x] 3.6 Remove the stored session in an `afterEach`, so that a case that fails still clears the sandbox. The suite shares one process, thus a file that stays makes a later `currentUserActor` read a real email
- [x] 3.7 Run `bun run test src/modules/auth/auth.test.ts src/modules/prov/prov.test.ts` and make sure that both pass

## 4. The cases of the stamp

- [x] 4.1 Add `readAuthor` to the shared helper of `src/modules/harness/turn.test.ts`, with a default that gives `null`
- [x] 4.2 Add a case for a signed-in identity: the recorded `appendTurn` payload carries that author
- [x] 4.3 Add a case for a signed-out identity: the recorded payload holds no `author` key
- [x] 4.4 Add a case for an interrupted turn with a signed-in identity: the partial append carries the author
- [x] 4.5 Add a case for a turn whose agent loop throws: the append of the user message carries the author
- [x] 4.6 Add a case for an empty email: the recorded payload holds no `author` key
- [x] 4.7 Add a case where `readAuthor` gives a different value on the second call: two turns of one engine record two different authors. A read that one constant memoizes must fail this case
- [x] 4.8 Run `bun run test src/modules/harness/turn.test.ts` and make sure that each case passes

## 5. The close-out

- [x] 5.1 Run `bun run format:file` on each changed file under `src/`
- [x] 5.2 Run `bun run lint` and `bun run typecheck`, and make sure that both pass
- [x] 5.3 Run `bun test` one time. Two failures are on the branch before this change: the notice-queue order case of `src/tui/hooks/run_completion.test.ts`, which depends on a sleep window, and "one fixture pool, two builders, the same tree" of `src/modules/libs/composition.test.ts`, which wants the Python `packaging` module. Report each other failure

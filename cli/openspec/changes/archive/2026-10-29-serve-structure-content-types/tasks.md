# Tasks

## 1. The structure types

- [x] 1.1 In `src/server/routes/files.test.ts`, add a test that reads a file of each structure extension of the spec delta. The test expects the type of the table and no `Content-Security-Policy`. Make sure that it fails before the change.
- [x] 1.2 In `src/server/routes/files.ts`, give `getMimeType` the hono table merged with the structure entries. Make sure that `bun run test src/server/routes/files.test.ts` passes.
- [x] 1.3 Run `bun run format:file` on the changed files, then `bun run typecheck` and `bun run lint`, and make sure that each passes.

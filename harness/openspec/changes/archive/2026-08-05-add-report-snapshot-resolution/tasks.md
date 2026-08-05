## 1. The contract

- [x] 1.1 Add `unreadable-artifact` to `UnresolvedReasonSchema` in `src/contracts/report-reference.ts`, with a doc comment that states when a resolver gives it
- [x] 1.2 Add an optional `fileType` field to `ArtifactSnapshot` in `src/report-model/reference-resolver.ts`, and document that it states a role and not a data format
- [x] 1.3 Document on `ArtifactSnapshot` that the mint never populates `rows`, and that `rows` serves the fixture realization only

## 2. The ledger query

- [x] 2.1 Add a query to `src/state/artifacts.ts` that gives the path, the hash, and the file type of each artifact of one analysis
- [x] 2.2 Apply no filter in the query, and document that a row with `unrecoverable_at` stays a member of the snapshot
- [x] 2.3 Give the query its own row type, and keep it consistent with the other exported queries of that file

## 3. The mint

- [x] 3.1 Add `src/report-model/mint-snapshot.ts` that mints a `ReportSnapshot` for one analysis from the ledger query
- [x] 3.2 Key the `artifacts` map by the path, and put the hash and the file type on the entry
- [x] 3.3 Make the mint give an empty `artifacts` map for an analysis with no registered artifact, and report no error
- [x] 3.4 Make the mint leave `citations` as it is, and add a comment that states why the mint fills no citation
- [x] 3.5 Return the mint result on the `Result` channel, per the house rules in `src/lib/result.ts`

## 4. The structural validation

- [x] 4.1 Add `src/report-model/structural-validation.ts` that validates one reference against a snapshot and opens no file
- [x] 4.2 Give `artifact-missing` for a path that the snapshot does not hold
- [x] 4.3 Give `hash-mismatch` for a reference whose `hash` differs from the entry
- [x] 4.4 Give `unreadable-artifact` for an `artifact-value` or an `artifact-table` reference against a `figure`, a `script`, a `log`, or a `notebook`
- [x] 4.5 Pass every other file type, pass an entry with no file type, and pass an `artifact-file` reference against each file type
- [x] 4.6 Pass a `citation` reference, because it holds no artifact pin
- [x] 4.7 Validate a `derivation` through its two inputs, and give the reason of the first input that fails
- [x] 4.8 Make the validation give no value, and make it match no assertion

## 5. The tests

- [x] 5.1 Add tests for the structural validation that cover each outcome of tasks 4.2 to 4.8
- [x] 5.2 Add a test that proves that the structural validation opens no file
- [x] 5.3 Add tests for the mint with `withSchema` from `src/__tests__/setup/postgres.ts`, covering three artifacts, no artifact, and an artifact that registers after the mint
- [x] 5.4 Add a test that proves that the mint keeps a row with `unrecoverable_at` set
- [x] 5.5 Add a test that proves that the mint copies no row

## 6. The verification

- [x] 6.1 Run `tsc -p tsconfig.json`, and correct each error
- [x] 6.2 Run the new test files only, and correct each failure
- [x] 6.3 Run `eslint .` in `harness`, and correct each finding
- [x] 6.4 Run `bun run format:file` on each changed file under `src/`
- [x] 6.5 Make sure that `src/index.ts` exports no part of the report model, because this work stays dormant
- [x] 6.6 Make sure that `validate.ts` keeps its current full resolution, and that no task changed it

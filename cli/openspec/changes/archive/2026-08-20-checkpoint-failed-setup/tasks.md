## 1. The record on disk

- [x] 1.1 Add `env.setupStatePath` to `StackPaths`, `stackPaths()`, `env`, and `envDoc`
- [x] 1.2 Name the file `setup-state.json`, and `setup-state.dev.json` on the dev channel
- [x] 1.3 Update the two `stackPaths` expectations and the cross-channel disjoint count

## 2. The step names and the read

- [x] 2.1 Add `SETUP_STEPS` in wizard order, and the `SetupStep` union it yields
- [x] 2.2 Add `setupStateSchema` with the step name and the version of the binary
- [x] 2.3 `readSetupState` resolves every fault to `null`, and a foreign version is one of them
- [x] 2.4 `writeSetupState` and `clearSetupState` give a `Result`, never a throw

## 3. The offer and the skip

- [x] 3.1 `offerContinue` asks one question ahead of `intro`, on a run that can prompt
- [x] 3.2 `done(step)` marks a step before the continue point. `asks(step)` withdraws its prompt
- [x] 3.3 Thread `asks(step)` through postgres, model, resources, embeddings, refs, and sandbox
- [x] 3.4 `chooseConnectionMode` takes `canAsk` and falls back to `resolveConnectionMode`
- [x] 3.5 Skip the connection block as one unit when the continue point is past it

## 4. The write seam

- [x] 4.1 Set `currentStep` at the head of each step
- [x] 4.2 Write the record in one `finally`, gated on `process.exitCode`
- [x] 4.3 Delete the record on the success path, and warn on a failed delete

## 5. Tests

- [x] 5.1 A complete run leaves no record
- [x] 5.2 A failed step records its own name and this binary's version
- [x] 5.3 A record from another version is ignored, and the completing run deletes it
- [x] 5.4 A continue silences the earlier steps and still asks the checkpoint step
- [x] 5.5 "Start again" asks every question

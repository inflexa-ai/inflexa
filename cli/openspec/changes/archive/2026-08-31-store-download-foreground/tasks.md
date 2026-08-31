# Tasks: store-download-foreground

## 1. The flag

- [x] 1.1 Register `--foreground` on `store download`, with the policy unchanged at `approval`
- [x] 1.2 The foreground branch of `runStoreDownload`: refuse a live transfer, run the worker in process, print the final row state, set the exit code

## 2. The proofs

- [x] 2.1 Prove with a test that a `failed` settle exits 1 and prints the recorded message
- [x] 2.2 Prove with a test that a live transfer refuses the foreground run with exit 1

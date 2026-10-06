## 1. The pin

- [x] 1.1 Set `SANDBOX_IMAGE` to the build tag `20261006-cdbff09` of `sandbox-base`.
- [x] 1.2 Make the image test refuse a moving tag, and make the migration test read the default from `SANDBOX_IMAGE`.
- [x] 1.3 Run `bun test src/modules/libs src/server/sandbox_gate.test.ts`.

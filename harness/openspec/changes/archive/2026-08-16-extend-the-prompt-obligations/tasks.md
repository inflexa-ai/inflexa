# Tasks: extend-the-prompt-obligations

## 1. The prompt pass

- [x] 1.1 The obligations land in their owning sections of `src/prompts/report-session.ts`, per the design.
- [x] 1.2 The "Do NOT" list gains the zero-p transcription and the raw-token prose, in the existing entry style.

## 2. The proof

- [x] 2.1 The prompt test pins the new obligations by substring, and the no-environment-detail assertions stay green.
- [x] 2.2 Run the prompt and agent suites, and `tsc -p tsconfig.json`.

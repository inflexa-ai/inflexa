# Tasks

## 1. The code

- [x] 1.1 Add `createReadSurfaceTools` and `createReadScriptTools`.
- [x] 1.2 Give the planner the read tools and the script reads, with a required `workspace` dep. Tell the planner prompt when to read.
- [x] 1.3 Give the synthesizer the read tools and the script reads. The assembly gives its workspace filesystem. Tell the synthesizer prompt when to read.

## 2. The checks

- [x] 2.1 Test the tools of the planner and of the synthesizer.
- [x] 2.2 Add a synthesis agent kind to the evals, with a case where a summary is thin and a case where the summaries suffice.
- [x] 2.3 Run the planner evals before and after the change, and the synthesis cases after it.

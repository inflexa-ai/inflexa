## 1. The run-event reader

- [x] 1.1 Make `subscribe` settle only after the handler takes the last part, with a test of a slow handler.
- [x] 1.2 When the streams end with no `data-run-completed` or `data-run-failed` part, read the run row up to 4 times at 500 ms. Deliver a `data-run-failed` part with `reason: "canceled"` when the row reads `canceled`.
- [x] 1.3 Add a test for each case of the canceled part:
  - A canceled run gets the part.
  - A run with its own terminal part gets no second part.
  - A row that becomes `canceled` on a later read gets the part.
  - A row that stays active gets no part.
- [x] 1.4 Document `reason: "canceled"` on `RunFailedPart`, and point the comment of the run canceler to the reader.

## 2. The farm lock path

- [x] 2.1 Let `EnvironmentStorePaths.farmLockFile` accept a function of the analysis id.
- [x] 2.2 Resolve the path with the analysis id of the session in `list_available_packages` and in the package resolution of the ad hoc router.
- [x] 2.3 Add the tests: a function path reads the farm lock of the analysis of the session, and a string path reads the same farm lock for each analysis.

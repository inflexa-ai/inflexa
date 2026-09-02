# Tasks — carry-the-image-inventory-in-the-store

## 1. The download merge

- [x] 1.1 Put `image-packages.json` on the update rule in `mergeStagedRoot`
  (`src/modules/libs/store_download.ts`): absent moves in, present stays
  on a plain download, and present is replaced whole under `replaceGraph`.
  Generalize `mergeStoreGraph` into one replaceable-record helper that the
  graph and the record both call, with an error message that names the
  entry.
- [x] 1.2 Update the module comment of `mergeStagedRoot` to name the three
  records that ride the update rule.

## 2. The extraction leaves

- [x] 2.1 Remove `imagePackagesFile` and `IMAGE_PACKAGES_PATH` from
  `src/modules/libs/packages.ts`. Keep `readPoolInventorySections`, and
  make the module header describe the pool inventory alone.
- [x] 2.2 Remove the extraction call after a runtime-image pull in
  `src/modules/libs/transfers.ts`.
- [x] 2.3 Remove the `resolveImagePackages` boot seam, its real
  realization, its call, and the missing-fragment warning from
  `src/modules/harness/runtime.ts`.
- [x] 2.4 Remove `libsDir` and its `envDoc` entry from `src/lib/env.ts`,
  and update the `packageStoreDir` comment that names it.

## 3. The static path

- [x] 3.1 Bind `imagePackagesFile` to
  `join(env.packageStoreDir, "image-packages.json")` at the three
  composition sites in `src/modules/harness/runtime.ts`.
- [x] 3.2 Make `RunEngineComposition.imagePackagesFile` a plain string in
  `src/modules/harness/run_deps.ts`, and pass it without the null guard.

## 4. Tests

- [x] 4.1 Merge tests: the record lands on the first download, a plain
  download keeps the present record, and `--update` replaces it whole.
- [x] 4.2 Remove the `resolveImagePackages` stub and its call-order
  assertion from `src/modules/harness/runtime.test.ts`.
- [x] 4.3 Update the composition fixture in
  `src/modules/harness/run_deps.test.ts` to carry the string path.

## 5. Verification

- [x] 5.1 Run the formatter on each changed source file, then the
  typecheck and the tests of the CLI.

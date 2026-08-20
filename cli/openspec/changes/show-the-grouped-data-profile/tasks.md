## 1. The count of the rail

- [x] 1.1 Add `profileFileTotal` to `hooks/sidebar_live.ts`, with the three-step fallback
- [x] 1.2 Read the total and the kind count in `profileLineOf` of `layout/sidebar.tsx`
- [x] 1.3 Keep the two-part line on a row that carries no kinds
- [x] 1.4 Cover the three-step fallback with unit tests
- [x] 1.5 Cover the grouped rail line with a render test

## 2. The blocks of the details view

- [x] 2.1 Add the subject block: domain, subtype, organism, tissue, cell type, condition,
      accessions, and design
- [x] 2.2 Render an explicit null organism as a finding, and an absent one as nothing
- [x] 2.3 Add the structure block: each kind, then the axes, then the coverage
- [x] 2.4 Rename the file heading to `described files`, and add the facts of each file
- [x] 2.5 Add the quality block, with the concerns before the strengths
- [x] 2.6 Emit no heading for a block that the row does not carry
- [x] 2.7 Cover each block with unit tests

## 3. The exhibit

- [x] 3.1 Give the mock profile kinds, axes, coverage, a subject, and a quality assessment

## 4. The specs

- [x] 4.1 Modify the rail requirement of `sidebar-live` for the count
- [x] 4.2 Modify the details requirement of `sidebar-live` for the blocks

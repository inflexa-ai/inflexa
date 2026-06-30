---
name: report-pptx
description: PowerPoint report rendering with python-pptx
version: 1.0.0
tags: [report, pptx, powerpoint, presentation]
---

# Report PPTX

Guidance for rendering PowerPoint presentations from structured Document JSON using python-pptx. The Document JSON is produced by the report-builder workflow's assemble step; its structure is described below.

## Document JSON Structure

The input document contains:

- **title**: Presentation title (analysis name)
- **sections[]**: Ordered content sections, each with `id`, `title`, `content` (narrative markdown), and optional `figures[]`
- **metadata**: `audience` (biologist/bioinformatician/clinical), `format` ("pptx"), `generatedAt`, `analysisId`

Each figure has a `figureId`, `path` (workspace-relative), `caption`, and `placement` (section ID).

## Rendering Pipeline

1. **Parse** the Document JSON and resolve figure paths against the workspace
2. **Convert charts** defined as ECharts configs into static PNG images using matplotlib/seaborn (see `references/chart-export.md`)
3. **Build slides** by mapping document sections to slide layouts (see `references/slide-layouts.md`)
4. **Save** the `.pptx` file to the output artifacts directory

## Section-to-Slide Mapping

- First section becomes the **Title Slide** using the document title and metadata
- Sections with figures get **Figure Slides** (one per figure, with caption)
- Sections with tabular data get **Table Slides**
- Sections with comparison content get **Two-Column Comparison** slides
- The final section becomes a **Summary Slide** if it contains key statistics
- All other sections become **Content Slides** with bullet points extracted from narrative text

## Audience Adaptation

- **biologist**: Emphasize biological interpretation, minimize technical parameters, larger fonts
- **bioinformatician**: Include method details, parameter tables, code references
- **clinical**: Focus on actionable findings, use clinical terminology, highlight significance

## References

- `references/slide-layouts.md` -- python-pptx slide layout patterns and branding
- `references/chart-export.md` -- Static chart image generation for slide embedding

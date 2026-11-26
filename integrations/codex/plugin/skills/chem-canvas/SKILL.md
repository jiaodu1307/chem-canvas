---
name: chem-canvas
description: Draw and revise publication figures as SVG in the local Chem Canvas project, optionally embedding verified molecular structures. Use also for inspecting and editing the shared research canvas.
---

# Publication figures

For data-only manuscript work, keep the measured results attached to the correct compound or mixture and distinguish quantitative assay yields from isolated yields. Compare the final drawing to the supplied stereochemical assignments. In dense schemes try journal abbreviations on the molecular slots and inspect the wedge or double bond at the attachment. For narrow experimental tables, the standalone text checker accepts a target size, for example `node scripts/check-svg-text.mjs figure.svg --print-width-mm 85`.

For a standalone journal illustration, write ordinary SVG directly. A standalone SVG, a text table and a plot from measured data can be produced with zero Chem Canvas calls. For a table, use native cells in the requested format; check data row by row and preserve printed emphasis, footnotes and missing-value symbols. For spectra with numerical series, plot those values and retain their units and legend. When only a figure is supplied, check curve separation and crossings at several wavelengths and describe data read from the image as approximate.

When the user wants the figure in a shared project, use `canvas_figure` to read its revision, preview the SVG, save with that revision and a unique operation ID, and export. Set `checkText: true` in a publication preview to check text bounds and length-adjusted labels. Inspect the resulting image at its intended print size for missing labels, incorrect arrows and clipping.

When the researcher refers to figure comments, read the named project and verify the figure ID. Open items in `figure.reviewNotes` have `resolvedAtRevision: null`. A point or a rectangle (`region.x,y,width,height`) uses fractions of the displayed artwork measured from the top left. For a current rectangle call `canvas_figure` with `mode: "read"` and its `reviewNoteId` to see the crop alongside the source. Check the selected feature against the comment, preview the local edit and save with the revision you read. After saving, read the same note with `compareWithCurrent: true` to inspect the original and current PNGs in that order. Match each image to its revision in `comparison.original` and `comparison.current`. Both crops use the same relative rectangle. If the layout moved, locate the feature again in the current artwork. Export the verified revision and tell the researcher which comments the change addresses.

When a structure should retain a machine-checkable molecular graph, use an existing molecule ID from the figure read. If needed, add its SMILES or authored MOL with `canvas_put_molecule` in the same project. Read the updated revision after a write. Place the saved structure inside the drawing with an empty slot such as `<svg data-molecule-id="ID" x="40" y="20" width="120" height="90"/>`. Add `data-abbreviations="journal"` when the reference uses condensed groups. Exported molecular evidence covers the bound slots. Geometry drawn with ordinary SVG paths can be assessed from the artwork.

For an explicitly depicted four- or six-coordinate metal, compare the preview’s `molecules[].coordinationCenters` and opposite-ligand pairs against the source, including the starting catalyst. A null geometry marks a missing archive assignment. Supply plain SMILES for explicit `@SP` or `@OH` geometry, or use `molblock` for authored 2D coordinates. Verify the stored geometry again after changing input format. Preserve uncertainty when the source leaves it open. Inspect the visible wedges independently, particularly around cropped molecule slots. Use native reaction objects when a later step needs to query or edit which structures participate in a transformation.

For a Word table, ordinary experimental data and text can be authored directly as native table cells. When an existing structured study needs editing, use `canvas_publication` if available. It exports editable DOCX measurement tables and standalone reaction SVGs.

# Shared research canvas

For existing molecular edits, selected atoms, reaction objects, proposals or edit history, read [the shared canvas workflow](references/canvas.md). Start with `canvas_read` for those tasks. When multiple projects exist, use the explicitly identified project throughout.

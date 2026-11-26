# Publication figure benchmark

[简体中文](README.md) · **English**

The gallery covers 16 figures and tables from eight papers. Four cases were drawn from data alone and 13 were redrawn with the source image visible. The palladium cycle appears in both groups. Each case page identifies the paper, the input condition and the individual drawings. [Open the gallery](https://jiaodu1307.github.io/chem-canvas/index.en.html#catalog)

## Revise one selected region

Select the upper OTs label on product 5b in the Fujita SVG blind draft. Submit a note asking the agent to open a gap in the crossing divider. Reopen the note to compare revisions, then score the exported SVG. All 91 changed pixels in the recorded run were inside the box. The corresponding feature in row 5c serves as a control for collateral edits. [Get the draft, note and scorer](local-selection/fujita-5b/) · [Inspect the before and after crops](https://jiaodu1307.github.io/chem-canvas/fujita-dioxytosylation.en.html#local-edit)

The two-note variant adds the same requested change on 5c, then hands off 5b alone. The scorer checks the actual clipboard request, the open 5c note and the exported pixels in both rows. [Compare the batch and single-note runs](local-selection/fujita-5b/#single-note)

In the Hosoya table, two conversions read 100. Both cells received the same note asking for bold type, and only the 80 °C, 20 min cell was assigned. All 148 changed pixels fell inside that cell. The data at all eight time points passed the check. [Run the identical-cell case](local-selection/hosoya-conversion/) · [Inspect the table](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.en.html#single-cell)

## Check print type sizes and editable Word tables

- **Hosoya · Table 2.** Preview the blind draft and the single-column proof at widths of 85 mm and 170 mm. Check all 40 values and their type sizes. [Print-width benchmark](publication/print-width/) · [Gallery results](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.en.html#print-width)
- **Aghahosseini · Table 1.** Compare all 66 cells in an eleven-row optimization table. Check that entry 5 is the only bold data row in the SVG preview and editable Word export. [Native-table benchmark](native-table/aghahosseini-row/) · [Gallery results](https://jiaodu1307.github.io/chem-canvas/aghahosseini-table1.en.html#row-emphasis)

## Run a paired comparison

Pick one input below. Start two fresh agent sessions and give each only the contents of that input. In the first session ask for editable SVG drawn directly. In the second allow Chem Canvas to embed molecules, preview the figure or export it. Save the raw outputs and record the model, version and tools used. Open the paper and review records after both drawings are finished. The original shared instructions for the Fujita, Kirij and Hosoya runs are recorded as `pairedTask`. [Read the paired protocol](publication/data-only/protocol.mjs)

| Case | Input for the drawing agent | Material for the reviewer |
| --- | --- | --- |
| Fiebor et al., Scheme 2 · five-step palladium cycle | [Reactions and coordination](publication/inputs/pd-pincer-cycle.txt) | [Compare runs and metal centres](https://jiaodu1307.github.io/chem-canvas/fiebor-scheme2.en.html#from-data) · [Paper](https://doi.org/10.3762/bjoc.14.160) |
| Fujita et al., Table 1 · regioselectivity and ee for three substrates | [Structures and results](publication/data-only/cases/fujita-dioxytosylation/brief.txt) | [Compare figures](https://jiaodu1307.github.io/chem-canvas/fujita-dioxytosylation.en.html#from-data) · [Review record](publication/data-only/cases/fujita-dioxytosylation/review.json) · [Paper](https://doi.org/10.3762/bjoc.14.53) |
| Kirij et al., Scheme 5 · two elimination routes and four E/Z alkenes | [Structures, yields and ratios](publication/data-only/cases/kirij-scheme5/brief.txt) | [Compare abbreviations](https://jiaodu1307.github.io/chem-canvas/kirij-scheme5.en.html#from-data) · [Review record](publication/data-only/cases/kirij-scheme5/review.json) · [Paper](https://doi.org/10.3762/bjoc.20.40) |
| Hosoya et al., Table 2 · eight time points across two batch oxidations | [Measurements and conversion definitions](publication/data-only/cases/hosoya-batch-oxidation/brief.txt) | [Compare tables](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.en.html#from-data) · [Review record](publication/data-only/cases/hosoya-batch-oxidation/review.json) · [Paper](https://doi.org/10.3762/bjoc.19.55) |

## Read the results

Each of the three `review.json` files preserves the original item-by-item assessment in Chinese, the run IDs and SHA-256 hashes for the SVG and PNG outputs. Check stereochemistry, reported numbers and label placement separately. When comparing drawing methods, select the two first drafts from the same input condition. The gallery labels proofread figures and renderer updates as later versions.

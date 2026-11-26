# Fujita 5b · 局部改图 / Region edit

## 中文

Fujita 等人在 Table 1 报告了三组苯乙烯实验。既有评阅发现，直接绘制的 SVG 中，产物 5b 和 5c 上方的 OTs 与行分隔线相交。本题模拟研究者只圈出 5b 要求修改。5c 是容易误改的对照。[文献](https://doi.org/10.3762/bjoc.14.53) · [原评阅](../../publication/data-only/cases/fujita-dioxytosylation/review.json) · [原始盲稿 SVG](https://jiaodu1307.github.io/chem-canvas/fujita-dioxytosylation-svg.svg)

1. 在独立的空项目中打开并保存原始盲稿。公开 checkout 内的文件是 `docs/fujita-dioxytosylation-svg.svg`。使用原始的 960 × 645 图稿坐标，框选从 (850, 272) 到 (902, 295) 的区域。框中应该能看到第二行产物 5b 的上方 OTs 和穿过它的浅灰横线。
2. 将下面这句话作为框选批注提交，让 Agent 读取图稿和批注、修改 SVG 并保存一版。测试 Agent 时只给原稿与批注，评分器留给评阅者。

   > 只改框中 5b 上方的灰色分隔线。在 y=282 处从 x=852 到 x=900 留出缺口，让 OTs 标签完整可见。其余线段、结构、文字、实验数据和 5c 保持原样。

3. 重新读取保存的图稿与版本，导出这一版 SVG。在下面的命令中用导出文件的路径替换 `exported.svg`。记录项目、批注、保存与导出的版本、Agent 及计分 JSON。
4. 从原批注同时查看旧版和新版的同一选区。记录目检时是否能辨认 5b 的 OTs 和缺口，再从全图确认 5c 仍与其原横线相交。程序按同一次运行的字体渲染原稿、目标和导出，逐像素检查框内及框外，并核对所有可编辑文字。

## English

Fujita et al. reported three styrene series in Table 1. In the earlier visual review, row dividers crossed the upper OTs labels on products 5b and 5c in the SVG blind draft. The researcher selects only 5b. Product 5c tests whether the agent also edits a similar feature elsewhere. [Paper](https://doi.org/10.3762/bjoc.14.53) · [Original review](../../publication/data-only/cases/fujita-dioxytosylation/review.json) · [Blind draft SVG](https://jiaodu1307.github.io/chem-canvas/fujita-dioxytosylation-svg.svg)

1. Open and save the blind draft in a new project. The published checkout includes it at `docs/fujita-dioxytosylation-svg.svg`. In the original 960 × 645 coordinate system, drag from (850, 272) to (902, 295). The box should enclose the upper OTs label in row 5b and the crossing divider.
2. Submit this region note. Give the agent the original artwork and the note. Keep the scoring script with the reviewer.

   > Edit the gray divider above 5b in the selected region. Leave a gap at y=282 from x=852 to x=900 so the OTs label is fully visible. Preserve the rest of the divider, all structures, labels and data, and row 5c.

3. Ask the agent to read the figure and note, edit the SVG and save a revision. Read back the saved revision and export its SVG. Score the export with the command below. Record project and note identifiers, saved and exported revisions, agent and score JSON.
4. Use the original note to view its region on both revisions. Visually inspect the upper OTs on 5b and the new gap. Check the full figure for the original crossing on 5c. Record these observations alongside the score. The scorer uses one local renderer and font set to compare the selected pixels to the requested gap and every outside pixel to the original. It checks the content and count of every editable SVG label.

## 实测记录 / Recorded run

![Fujita 5b, OTs label and divider in revisions 2 and 3](comparison.png)

实际批注要求在分隔线与 5b 标签交叠处留白。保存新版后，旧流程只能提示该批注属于旧稿。本次复测用同一条批注取回了 r2 和 r3 的两张选区图，以上按四倍放大展示。图上可见灰线从字中穿过，修改后两端停在字外。对 r3 导出文件的程序核查记录了 91 个框内像素变化、零个框外变化，全部 41 个标签均保留。

The recorded note asked for a gap where the divider crossed 5b. Previously, reopening the note after saving returned a stale-position error. The retest retrieved crops from r2 and r3 through the same note. Shown at 4×, the gray rule crosses OTs on the left and stops on either side on the right. The export check counted 91 changed pixels inside the box, zero outside, and all 41 original labels. [Recorded r3 export](example-export.svg)

## 运行 / Run

在安装依赖后的仓库根目录执行。Run from the repository root after `npm ci`.

```sh
node benchmarks/local-selection/fujita-5b/check.mjs --self-test
node benchmarks/local-selection/fujita-5b/check.mjs benchmarks/local-selection/fujita-5b/example-export.svg
node benchmarks/local-selection/fujita-5b/check.mjs exported.svg
```

计分成功时退出码为 0。通过需要 `selectedMismatchPixels` 和 `outsideSelectionChangedPixels` 均为 0，且 `editableLabelsPreserved` 为 true。`control5cChangedPixels` 单列 5c 对应框中的像素差异。`targetChangedPixels` 是本机渲染时参考缺口实际改变的像素数。

A passing export exits with status 0. Both `selectedMismatchPixels` and `outsideSelectionChangedPixels` must be zero, and `editableLabelsPreserved` must be true. `control5cChangedPixels` reports outside changes in the corresponding 5c box. `targetChangedPixels` measures the visible change expected from the reference gap using the local renderer.

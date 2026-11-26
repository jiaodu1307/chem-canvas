# Hosoya · 两个相同的转化率 / Two identical conversions

## 中文

Hosoya 等人的 Table 2 第 5、6 组实验共有 8 个时间点。原始 SVG 把两个转化率都写为 `100`。本题让研究者分别框选这两个单元格，给出一字不差的批注，然后只把 80 °C、20 min 的那条交给 Agent。[案例与文献出处](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.html) · [原始 SVG](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation-svg.svg)

1. 在独立的空项目中保存原始 SVG。按原图 1000 × 730 的坐标，先框选 60 °C、60 min 的转化率，范围为 (846, 472) 到 (900, 495)。再框选 80 °C、20 min 的转化率，范围为 (846, 527) 到 (900, 550)。两次都保存相同的文字「仅将选中的转化率数字加粗，保留测量值。」
2. 在第二条批注点击「复制这条给 Agent」。将复制文本交给 Agent。评阅者保存这份文本及两个批注 ID。请求应只包含第二条的 ID。Agent 按请求读取该项目和批注，用返回的选框定位数字，直接修改 SVG，预览、保存，再回读并导出该版本。
3. 在仓库根目录安装依赖后，运行下方命令。评分器按原稿两个可编辑 SVG 分组及单元格位置，核对 8 行中各自的时间、3 项 HPLC 峰面积和转化率。它比较原稿、参考加粗图与导出的像素，要求目标字形与参考一致，框外与对照格均无像素变化。采用另一种 SVG 表格结构的等价重绘需要另行评阅。

## English

Entries 5 and 6 of Hosoya et al.’s Table 2 contain eight time points. Two cells in the conversion column read `100`. The researcher leaves identical comments on both and assigns only the 80 °C, 20 min cell. [Case and paper](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.en.html) · [Original SVG](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation-svg.svg)

1. Save the original SVG in a new project. On the 1000 × 730 artwork, drag from (846, 472) to (900, 495) around the 60 °C, 60 min conversion. Then drag from (846, 527) to (900, 550) around the 80 °C, 20 min conversion. For both notes, enter “仅将选中的转化率数字加粗，保留测量值。” (“Bold only the selected conversion figure and preserve the measured value.”)
2. Use the second comment’s **复制这条给 Agent** button. Give the agent just the copied text. Record both note IDs and the clipboard text. The request should contain only the second ID. Have the agent read that note, locate the numeral using its returned rectangle, edit the SVG, preview, save, read back and export the saved revision.
3. With the repository dependencies installed, score the exported SVG from the repository root. The scorer checks all five values for each time point against the draft’s two editable series and cell positions. It compares the selected cell with a reference bold rendering and checks that every pixel outside the selection, including the other `100`, matches the original. Equivalent redraws using a different SVG table structure require separate review.

下方第一条命令复核此次实测导出。第二条用于自己的文件。 The first command checks the recorded export. The second checks your own file.

```sh
node benchmarks/local-selection/hosoya-conversion/score.mjs benchmarks/local-selection/hosoya-conversion/example-export.svg
node benchmarks/local-selection/hosoya-conversion/score.mjs exported.svg
```

本次确定性执行器使用真实 Edge 和 MCP。r3 包含两条批注。执行器通过选框内 SVG 数字的可见包围框中心唯一定位目标，保存 r4。8 行数据全部通过，目标改变 148 像素，框外改变 0 像素。字形的实际像素数取决于运行环境中的字体。

The recorded run used Edge, MCP and a deterministic executor. Both notes were present at r3. Exactly one numeric SVG text element had its rendered center inside the returned rectangle. The executor bolded that element and saved r4. All eight rows passed, with 148 pixels changed inside the target and zero outside. The exact count depends on the installed font.

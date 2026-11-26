# Hosoya · 印刷字号 / Type size at print width

Hosoya 等人 Table 2 中第 5、6 组的批式氧化实验各有 6 和 2 个时间点。本例使用公开展厅的两份 SVG。盲稿在 1000 个设计单位宽的图上用 17 单位排表格数字。校样将图重排至 360 单位宽，并用 12 单位排同一批数字。[原稿](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation-svg.svg) · [校样](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation-proofread.svg) · [案例与文献](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.html)

The two SVGs report the same eight time points from entries 5 and 6 of Hosoya et al.’s Table 2. The original draft sets the table figures at 17 design units across a 1000-unit page. The proofread version sets them at 12 units across a 360-unit page. The narrower layout gives the digits a larger physical size at the same final print width. [Gallery and paper](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.en.html)

| 图稿 / Artwork | 印刷宽度 / Print width | 40 个表格数字 / Table figures | 全图最小获测字号 / Smallest assessed run |
|---|---:|---:|---:|
| 盲稿 / Original | 85 mm | 4.10 pt | 2.89 pt |
| 校样 / Proofread | 85 mm | 8.03 pt | 6.89 pt |
| 盲稿 / Original | 170 mm | 8.19 pt | 5.78 pt |
| 校样 / Proofread | 170 mm | 16.06 pt | 13.77 pt |

### 复跑 / Reproduce

在仓库根目录安装依赖后运行以下命令。脚本使用独立临时项目，在本地 HTTP 服务上通过 MCP 调用 `canvas_figure`，并实际下载 SVG。

With dependencies installed, run the command from the repository root. The script starts an isolated local project, calls `canvas_figure` through an MCP client and downloads the SVG exports.

```sh
node benchmarks/publication/print-width/check.mjs
```

### 核验内容

- 传 `mode:"preview"`、SVG 源码和 `printWidthMm`，分别测量 85 和 170 mm。脚本将 `textPreflight.printFonts` 的每个文本片段与离线检查器比对，并按原始表格顺序核对 8 行的时间、三项 HPLC 峰面积与转化率，共 40 个数值。
- 表格数字的独立计算为「设计字号 × 印刷宽度 ÷ 设计宽度 × 72 ÷ 25.4」，结果保留两位小数。报告使用名义字号。字形本身的着墨高度还受字体影响。
- 省略印刷宽度时，普通预览返回图稿。仅传 `checkText:true` 时，返回原有文字预检。脚本比较各次预览前后的项目回读和实际下载文件的 SHA-256。
- 在提交 `4b0abd2` 上，对同一盲稿传 `checkText:true` 和 `printWidthMm:85`，HTTP 与 MCP 都成功返回了边界和重叠检查结果，未返回字号字段。

### Checks

- At each width the client supplies the SVG source and `printWidthMm` in preview mode. The complete `textPreflight.printFonts` report must match the offline checker. The time, three HPLC peak areas and conversion must match all 40 printed values in their original order.
- The independent calculation for these table figures is design type size × print width ÷ design width × 72 ÷ 25.4, rounded to two decimal places. The report measures nominal vertical em size in points. Visible ink height also depends on the font.
- With the width omitted, ordinary preview returns the artwork. Passing only `checkText:true` requests the existing text checks. The benchmark compares the saved project and the SHA-256 of downloaded exports before and after the previews.
- At commit `4b0abd2`, HTTP and MCP accepted `checkText:true` and `printWidthMm:85` for the same original draft. Both returned the bounds and overlap checks without a print-size field.

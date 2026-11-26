# Aghahosseini Table 1 · 表格行强调 / Table row emphasis

原表有 11 行实验、6 列数据。表头加粗，第 5 行是唯一加粗的数据行，条件为无水乙醇、哌啶、78 °C、16 h，收率 56%。[论文 Table 1](https://doi.org/10.1371/journal.pone.0306973.t001) · [独立转录的输入](study.json) · [已验证的可编辑 Word 表](example.docx)

The source has eleven experiments and six columns. The header is bold. Entry 5 is the only bold data row and records absolute ethanol, piperidine, 78 °C, 16 h and 56% yield. The native template prints the percent sign with each numeric yield. [Table 1 in the paper](https://doi.org/10.1371/journal.pone.0306973.t001) · [Input specification](study.json) · [Verified editable Word table](example.docx)

## 给 Agent 的任务 / Agent task

在独立项目中打开原生出版表格，保存 `study.json`。把第 5 个实验整行设为粗体，保留其余数据、表头与行序。预览、保存、回读，并导出 SVG 和 DOCX。在出版工作台也可勾选对应实验的「表格行加粗」。

Save the input as a native publication table in a new project. Make the entire data row for entry 5 bold. Preserve the other values, header and row order. Preview, save, read back, and export SVG and DOCX. In the publication editor the checkbox is in the experiment’s table-row emphasis column.

## 复核 / Replay

在仓库根目录安装依赖后执行。第二条命令可检查 Agent 返回的出版表格 JSON。Run from the repository root after `npm ci`. The second form checks a candidate specification from your agent.

```sh
node benchmarks/native-table/aghahosseini-row/check.mjs
node benchmarks/native-table/aghahosseini-row/check.mjs candidate.json
```

改进前，预览拒绝 `experiments[4].bold`，Word 第 5 行的 6 格均为常规字重。现在可对该实验指定可选布尔字段 `bold`。检查器在临时项目保存原稿和修订稿，回读两个版本，再核对 HTML 预览、导出 SVG、原生 Word 表格的全部可见文字片段。实测 66 个数据格的内容一致，只有第 5 行的 6 格加粗。另用 Microsoft Word 打开示例，六格均显示粗体。分子图与底物范围卡片的排版独立于表格行样式。

The original preview rejected `experiments[4].bold` and all six Word cells on entry 5 had regular weight. The optional boolean field `bold` now controls a row’s weight. The scorer saves both versions in a temporary project, reads them back, and checks the HTML preview, exported SVG and visible text runs in the editable Word table. All 66 data cells retained their content. Only the six cells of entry 5 were bold. Microsoft Word also displayed bold type in all six cells. The field applies to table rows.

Data transcribed from Fatemeh Aghahosseini, Mohammad Bayat, Zahra Sadeghian, Davood Gheidari and Fatemeh Safari, *PLOS ONE* (2024), Table 1. [Source and attribution](https://doi.org/10.1371/journal.pone.0306973.t001) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

# 期刊绘图 benchmark

**简体中文** · [English](README.en.md)

在[图稿展厅](https://jiaodu1307.github.io/chem-canvas/#catalog)中可以查看 16 个文献图表案例。4 个案例做过「只给数据」实验，13 个做过「看原图重绘」实验。钯催化循环同时做过两种实验。每个案例页都标出论文出处和输入条件，可以切换图稿、放大结构、查看核对记录。

## 框选后修改同一处

在 Fujita 的纯 SVG 盲稿上框住产物 5b 的 OTs，提交批注，让 Agent 为穿过文字的分隔线留出缺口。用原批注回看两版，再给导出的 SVG 计分。实测改变的 91 个像素均在框内，下一行 5c 可用作误改对照。[取用原稿、批注和计分器](local-selection/fujita-5b/) · [放大修改前后对照](https://jiaodu1307.github.io/chem-canvas/fujita-dioxytosylation.html#local-edit)

双批注用例在 5c 加入相同的修改需求，只转交 5b。评分器分别核对真实剪贴板请求的范围、5c 的待处理状态和两行的导出像素。[复核批量请求与单条请求](local-selection/fujita-5b/#single-note)

Hosoya 表格中有两个转化率都是 100，研究者给两格写下相同的加粗要求，只转交 80 °C、20 min 的那格。实测有 148 个像素改变，全部在目标格内，八个时间点的数据均通过核对。[取用同值单元格用例](local-selection/hosoya-conversion/) · [查看表格案例](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.html#single-cell)

## 核对印刷字号和可编辑 Word 表

- **Hosoya · Table 2**　让 Agent 分别按 85 mm 和 170 mm 宽预览盲稿与单栏校对稿，逐项核对 40 个数字和字号。[字号 benchmark](publication/print-width/) · [展厅结果](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.html#print-width)
- **Aghahosseini · Table 1**　对照 11 行、6 列的条件筛选表，核验 SVG 预览和可编辑 Word 表格是否仅在第 5 个数据行使用粗体。[原生表格 benchmark](native-table/aghahosseini-row/) · [展厅结果](https://jiaodu1307.github.io/chem-canvas/aghahosseini-table1.html#row-emphasis)

## 用同一份输入比较两种画法

选择一份下表的 **输入**，在两个全新会话中分别作图。只把输入文件正文发给绘图 Agent，论文、结果页及评分留到评阅阶段。第一组直接写可编辑 SVG；第二组允许使用 Chem Canvas 嵌入分子结构、预览或导出。记录所用模型与版本、工具和原始输出，随后在结果页对照。Fujita、Kirij、Hosoya 三个实验共用的原始任务措辞保存在 [protocol.mjs](publication/data-only/protocol.mjs) 的 `pairedTask` 中。

| 案例 | 输入 | 对照与评阅 |
| --- | --- | --- |
| Fiebor 等 · Scheme 2，五步钯催化循环 | [反应与配位关系](publication/inputs/pd-pincer-cycle.txt) | [各次绘图与配位中心核对](https://jiaodu1307.github.io/chem-canvas/fiebor-scheme2.html#from-data) · [论文](https://doi.org/10.3762/bjoc.14.160) |
| Fujita 等 · Table 1，三组底物的区域选择性与 ee | [结构与实验结果](publication/data-only/cases/fujita-dioxytosylation/brief.txt) | [查看各版图稿](https://jiaodu1307.github.io/chem-canvas/fujita-dioxytosylation.html#from-data) · [逐项记录](publication/data-only/cases/fujita-dioxytosylation/review.json) · [论文](https://doi.org/10.3762/bjoc.14.53) |
| Kirij 等 · Scheme 5，两条消除途径与四个 E/Z 烯烃 | [结构、收率与比例](publication/data-only/cases/kirij-scheme5/brief.txt) | [图稿与缩写核对](https://jiaodu1307.github.io/chem-canvas/kirij-scheme5.html#from-data) · [逐项记录](publication/data-only/cases/kirij-scheme5/review.json) · [论文](https://doi.org/10.3762/bjoc.20.40) |
| Hosoya 等 · Table 2，两组批式氧化实验的八个时间点 | [测量值与转化率定义](publication/data-only/cases/hosoya-batch-oxidation/brief.txt) | [图稿与表格核对](https://jiaodu1307.github.io/chem-canvas/hosoya-batch-oxidation.html#from-data) · [逐项记录](publication/data-only/cases/hosoya-batch-oxidation/review.json) · [论文](https://doi.org/10.3762/bjoc.19.55) |

## 如何读结果

三份 `review.json` 分别记录纯 SVG 初稿和插件初稿的逐项核对，含运行 ID、SVG 和 PNG 的 SHA-256。两份稿件可以分别在立体构型、数字和标签排版上得失分。网页另列的校对稿和渲染器更新结果各有版本标签，比较初稿时请选择同一输入条件下的对应版本。

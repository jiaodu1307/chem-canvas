# 期刊绘图 benchmark

在[图稿展厅](https://jiaodu1307.github.io/chem-canvas/#catalog)中可以查看 16 个文献图表案例。4 个案例做过「只给数据」实验，13 个做过「看原图重绘」实验。钯催化循环同时做过两种实验。每个案例页都标出论文出处和输入条件，可以切换图稿、放大结构、查看核对记录。

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

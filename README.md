# Chem Canvas

Chem Canvas 是本地运行的有机化学绘图与研究画布。人和 Agent 在同一份项目中审阅可编辑 SVG，按需嵌入具有结构记录的 RDKit 分子。项目保存在本机，Agent 通过 Model Context Protocol（MCP）连接。宿主可以启动本地 stdio 进程，也可以连接可选的本机 Streamable HTTP 服务。

## 运行

安装 Node.js 24 或更高版本，在仓库根目录执行以下命令。

```sh
npm ci
npm test
npm start
```

打开 [研究画布](http://127.0.0.1:4317/)、[SVG 工作台](http://127.0.0.1:4317/figure.html) 或[文献案例目录](http://127.0.0.1:4317/publication-benchmark.html)。在案例目录中可打开本仓库的示例图稿，点击「保存图稿」，然后点选图面添加批注。文献目录给出论文、图表编号、原出版方链接和逐项许可信息。

## 接入 Agent

从集成指南选择客户端。浏览器中选择的项目、已保存的图稿和批注可通过同一个本地服务读取。[Agent 配置与兼容范围](docs/agent-hosts.zh-CN.md)

```sh
node scripts/plugin-config.js --profile figure
```

`figure` 提供整图预览、保存和导出。`figure-chemistry` 还支持解析或写入分子。`full` 提供共享选区、修改提案和项目历史等工具。

使用本仓库的 Codex 本地插件时，先在当前 checkout 生成 MCP 配置，再添加本地市场。生成的配置会指向当前仓库的绝对路径。移动目录后重新运行准备命令。

```sh
node integrations/codex/prepare.mjs
codex plugin marketplace add ./integrations/codex
codex plugin add chem-canvas@chem-canvas-local
```

## 数据与依赖

默认工作区位于 `.local/workspace/`。源码版使用合成输入进行测试。论文著作权和依赖条款见 [Third-party notices](THIRD_PARTY.md)。

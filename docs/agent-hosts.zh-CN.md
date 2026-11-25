# Agent 接入 Chem Canvas

支持本地 **MCP stdio** 的 Agent 可以启动同一份 Chem Canvas。模型、对话、工具授权由宿主管理。画布在本机保存项目、绑定分子结构、记录图稿与批注。只需生成普通 SVG 或实验表格时，也可以直接在对话中完成。

## 在自己的机器上配置

首次安装可直接把[中文安装提示词](install-agent.zh-CN.md)发给当前 Agent。安装器按实际客户端合并 `chem-canvas`，支持保留 JSONC 注释。以下命令省略安装目标时会打印配置供检查。

在 Chem Canvas 源码根目录使用 Node.js 24 或更高版本运行：

```sh
npm ci
node scripts/plugin-config.js --host cursor --profile figure-chemistry
```

重新连接或重启宿主，在工具列表查找 `canvas_figure`（一些宿主会在名称前加服务器名）。生成器为脚本写入当前 checkout 的绝对路径。TRAE 要求启动命令不含空格，Node 可执行文件路径含空格时会使用 IDE 的 PATH 查找 `node`。换机器或移动源码后重新生成配置。默认运行于 `http://127.0.0.1:4317`。

| 宿主 | `--host` | 合并到哪里 |
| --- | --- | --- |
| TRAE IDE（本地任务或工作树） | `trae` | 工作区 `.trae/mcp.json`。在设置 → MCP 中启用项目级 MCP，并在当前智能体启用服务。[TRAE 国内文档](https://docs.trae.cn/ide_add-mcp-servers) |
| TRAE CLI 2.0 | `trae-cli` | 将输出的 TOML 表合并到 `~/.trae/traecli.toml`，在 TUI 使用 `/mcp` 检查。工具范围和项目通过命令参数传递。[CLI 配置文件](https://docs.trae.cn/cli_config-file) |
| Qoder CN 国内版 IDE | `qoder-cn` | `--install-user` 合并到 `~/.qoder-cn/mcp.json`。设置 → MCP 服务 → 我的服务中可展开工具。[国内版 IDE](https://docs.qoder.cn/user-guide/guide-for-using-mcp) |
| Qoder CLI（国际版 / 国内版） | `qoder-cli` | `--install-project` 合并到 `.qoder/settings.local.json`。从该工作区运行 `qoder mcp list` 或 `qodercn mcp list`。[国际版 CLI](https://docs.qoder.com/cli/mcp-servers) · [国内版 CLI](https://docs.qoder.cn/cli/mcp-reference) |
| Qoder 桌面应用（Connectors）或传统国际版 IDE | `qoder` | Connectors 桌面用 `--install-user` 写入 `~/.qoder/settings.json`。传统国际版 IDE 用 Settings → MCP → My Servers → Add 打开配置，传该文件给 `--install-file`。[桌面 Connectors](https://docs.qoder.com/qoder/connectors) · [国内桌面 Connectors](https://docs.qoder.cn/qoder/connectors) · [国际版 IDE](https://docs.qoder.com/user-guide/chat/model-context-protocol) |
| Kimi Code CLI | `kimi` | 项目 `.kimi-code/mcp.json`，或用户 `~/.kimi-code/mcp.json`（尊重 `KIMI_CODE_HOME`）。项目配置生效需要信任当前工作区，新会话中使用 `/mcp` 检查。[Kimi Code MCP](https://www.kimi.com/code/docs/kimi-code-cli/customization/mcp.html) |
| Codex CLI / 桌面端本地环境 | `codex` | `~/.codex/config.toml` 中的 `mcp_servers`。已安装项目的原生 Codex 插件时可直接使用已有连接。[官方配置](https://developers.openai.com/codex/mcp) |
| Claude Code | `claude-code` | 工作项目根目录的 `.mcp.json`。运行 `claude mcp get chem-canvas` 查看连接状态。[官方配置](https://code.claude.com/docs/en/mcp) |
| Claude Desktop | `claude-desktop` | 设置 → Developer → Edit Config，对应 `claude_desktop_config.json`。[本地服务器配置](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| Cursor | `cursor` | 项目 `.cursor/mcp.json` 或用户 `~/.cursor/mcp.json`。[官方配置](https://cursor.com/docs/mcp) |
| VS Code 编辑器中的 Copilot | `vscode` | 工作区 `.vscode/mcp.json` 中的 `servers`。可用「MCP: List Servers」检查。[官方配置](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json` 中的 `mcpServers`。工具范围由 Chem Canvas 的 `--profile` 控制。[官方配置](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) |
| Gemini CLI | `gemini` | `.gemini/settings.json` 中的 `mcpServers`。在会话中输入 `/mcp` 查看。[官方配置](https://geminicli.com/docs/tools/mcp-server/) |
| OpenCode（使用 `mcp.servers` 的版本） | `opencode` | 工作项目 `opencode.jsonc`。本地服务器使用 `type: "local"` 和命令数组。[官方配置](https://opencode.ai/docs/mcp-servers/) |
| Zed | `zed` | Settings → AI → MCP Servers，或合并到 settings.json 的 `context_servers`。[官方配置](https://zed.dev/docs/ai/mcp) |
| 其他可启动本地 stdio 进程的宿主 | `generic`（默认） | 使用 `mcpServers` JSON 的客户端可直接合并。表单式客户端将 `command` 填入可执行文件、`args` 逐项填入参数、`env` 填入环境变量。 |

**选择工具范围。** `--profile figure` 提供一个整图工具，可读取批注、预览、保存、导出；`figure-chemistry` 额外提供分子录入和解析。需要读取卡片引用、处理分子提案或查看修改历史时用 `full`，它也是缺省设置。支持工具返回图片的宿主可以直接展示 PNG 预览；文本客户端可读取图稿工具返回的本机编辑页和导出链接。

**绑定明确的项目。** 多个会话共同修改同一项目时，可在命令中加上 `--project <项目ID>`；这里填写画布网址中的项目 ID。需要从另一个安装目录启动一份独立服务时，用 `--url http://127.0.0.1:4318` 选择另一个可用端口。MCP 进程需要与研究画布处于同一运行环境。远程 IDE、容器或 WSL 中可把 Node、源码和画布一并放在该环境。

## 使用 Streamable HTTP 的客户端

支持 MCP Streamable HTTP 的客户端也可以连接同一组工具。在画布所在机器运行：

```sh
node scripts/plugin-http.js --project default --profile figure
```

在客户端选择 **Streamable HTTP**，填写 `http://127.0.0.1:4327/mcp`。将 `default` 换成要授权的已存在项目。启动器会检查该项目，所有连接都绑定它。每个调用使用独立的无状态传输，写入继续使用项目 revision 与 operationId。可以用 `--port` 修改 MCP 端口，用 `--url` 指向同机画布。停止该命令即可关闭此 MCP 入口。

该进程只监听 IPv4 回环，检查请求的 Host 和浏览器 Origin，并拒绝跨站请求。其他机器上的客户端需要已有受控 HTTPS 网关转发到这一个 `/mcp` 路径。网关负责认证、授权、校验外部来源，并使用后端的回环 Host。桥接进程信任本机连接；外部接入应先配置网关的访问控制。云端宿主还可能要求特定 OAuth 流程，此仓库只验证了标准 HTTP 传输。远程客户端可在导出时请求 `includeSvg: true` 直接读图稿，工具返回的编辑页与下载链接指向画布所在机器。[协议与传输要求](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## 验收

给 Agent 一条只读指令：“读取当前项目的图稿，告诉我项目 ID、版本号和待核对的批注。” 若项目尚无图稿，空图稿也是正常结果。需要修改时再明确给出目标对象或图上批注。

```sh
node scripts/plugin-doctor.js --mcp --profile figure-chemistry
node --test tests/plugin-host-config.test.js tests/plugin-doctor.test.js tests/plugin-http.test.js
```

测试会读取 TRAE、Qoder CN IDE、Qoder 桌面、Qoder CLI 和 Kimi Code 的安装文件，从独立工作目录启动配置指定的 stdio 进程，发现工具并只读打开图稿。还覆盖同名冲突、重复安装、原有 JSONC 注释与其他服务。绘图回归会在临时项目中保存、回读和导出 SVG，并检查项目隔离。实际宿主能否看到工具，可在相应客户端中执行[验证口令](install-agent.zh-CN.md)。

Codex 的 app-server 使用生成的 TOML 和独立配置目录完成了原生工具发现，只列出绘图配置中的 `canvas_figure`。Claude Code 2.0.62 在独立配置目录中用生成的 JSON 注册服务器，`claude mcp get chem-canvas` 实测返回 `Connected`。图稿读写和导出由上述 MCP SDK 回归验证。Cursor、Claude Desktop、VS Code、GitHub Copilot CLI、Gemini CLI、OpenCode 和 Zed 的配置已对照各自官方格式，这七个宿主的实际界面还有待逐端验收。

Windows 上使用官方 Qoder CLI 1.1.97，在临时工作区执行本指南的 `--host qoder-cli --install-project` 命令后，`qoder mcp list` 和 `qoder mcp get chem-canvas` 都报告 `Connected`。后者同时确认了项目本地配置路径、stdio 传输和 `figure-chemistry` 工具范围。该验收没有发起模型请求。

同一平台上的官方 Kimi Code 2.7.3 从工作区读取安装器写入的 `.kimi-code/mcp.json`，启动 Node 子进程，完成 MCP 握手并枚举出 `canvas_figure`、`canvas_put_molecule`、`chemistry_parse`。TRAE IDE、TRAE CLI 2.0、Qoder CN IDE、Qoder 国内 CLI 和 Qoder 桌面应用的验证覆盖配置格式与实际 stdio 进程；各产品界面中的工具调用仍待实测。

HTTP 回归使用 SDK 的 `StreamableHTTPClientTransport` 连接独立临时项目，发现工具、保存、回读并导出 SVG，同时验证项目不匹配、错误 Host、错误 Origin、跨站与错误路径均被拒绝。

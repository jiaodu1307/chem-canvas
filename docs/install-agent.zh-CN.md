# 让 Agent 安装 Chem Canvas

将下面整段发给能在本机运行命令的编程 Agent。已有源码的用户也可以直接在本地使用这段提示词。

```text
请帮我把 Chem Canvas 安装到当前使用的 Agent，并实际验证。仓库是 https://github.com/jiaodu1307/chem-canvas。
如果已经有这份源码就复用，否则克隆到一个长期保留的目录。
先记住我当前打开的工作区，按仓库 docs/install-agent.zh-CN.md 识别宿主和版本，安装 figure-chemistry 配置，保留已有 MCP 服务。
完成后请调用 canvas_figure 只读打开图稿，告诉我项目 ID、修订号和画布链接。
如果必须由我启用开关或重开会话，请告诉我具体操作和验证口令。
```

## 给执行安装的 Agent

1. 记下**用户打开的工作区绝对路径**。它是宿主读取项目设置的位置。选一个长期保留的目录运行 `git clone https://github.com/jiaodu1307/chem-canvas.git`，或复用已有源码。如果旧副本缺少本指南，可另克隆新版以保留用户的本地改动。私有仓库需要当前 GitHub 账号有读取权限，也可以使用仓库成员提供的新版源码包。
2. 在 Agent 实际运行的环境检查 `node --version`、`npm --version`。需要 Node.js 24 或更高版本；如果缺少，通过已有 Node 版本管理器安装 24，或使用 Node.js 官方安装包。在 Chem Canvas 根目录运行 `npm ci`。根据当前宿主、命令帮助或设置页识别客户端与版本；仍有歧义时询问宿主名称。只配置用户正使用的宿主。[Node.js 下载](https://nodejs.org/en/download)
3. 在源码目录执行下表对应的命令。将 `<工作区>` 替换为第 1 步的路径，保留引号。配置完成后源码目录需要继续存在。连接时插件会按需启动本机画布。

| 当前宿主 | 安装命令 | 在哪里确认生效 |
| --- | --- | --- |
| TRAE IDE 本地任务 / 工作树 | `node scripts/plugin-config.js --host trae --profile figure-chemistry --install-project "<工作区>"` | 设置 → MCP → 启用「项目级 MCP」。确认当前智能体已启用该服务。Windows 下若生成的命令是 `node`，在 IDE 终端确认 `node --version` ≥ 24。 |
| TRAE CLI 2.0 | `node scripts/plugin-config.js --host trae-cli --profile figure-chemistry`，由 Agent 将输出的 `[mcp_servers.chem-canvas]` 表合并到 `~/.trae/traecli.toml` | 在 CLI 会话输入 `/mcp`。 |
| Qoder CN 国内版 IDE | `node scripts/plugin-config.js --host qoder-cn --profile figure-chemistry --install-user` | 设置 → MCP 服务 → 我的服务，展开 `chem-canvas` 查看工具。在智能体模式调用。 |
| Qoder CLI 国际版 / 国内版 | `node scripts/plugin-config.js --host qoder-cli --profile figure-chemistry --install-project "<工作区>"` | 在同一个工作区运行 `qoder mcp list` 或 `qodercn mcp list`，在会话中用 `/mcp` 看连接。 |
| Kimi Code CLI（使用 `.kimi-code` 的版本） | `node scripts/plugin-config.js --host kimi --profile figure-chemistry --install-project "<工作区>"` | 在同一工作区新开 Kimi 会话，按宿主提示信任该工作区，输入 `/mcp`。 |
| Qoder 桌面应用，设置中有 Connectors | `node scripts/plugin-config.js --host qoder --profile figure-chemistry --install-user` | 在 Connectors 中确认 `chem-canvas`。使用传统国际版 Qoder IDE 时，从 Settings → MCP → My Servers → Add 打开实际 JSON，再用 `--install-file "<配置文件>"`。 |
| Cursor / VS Code / Claude Code / Gemini CLI | `node scripts/plugin-config.js --host <宿主> --profile figure-chemistry --install-project "<工作区>"` | `<宿主>` 分别填 `cursor`、`vscode`、`claude-code`、`gemini`。在该工作区重新加载 MCP。 |

Codex、其他 JSON 客户端和 Streamable HTTP 的对应步骤见[宿主接入指南](agent-hosts.zh-CN.md)。使用 Codex 时，可用仓库 README 中的原生插件安装方式，或将 `--host codex --profile figure-chemistry` 输出的两个 TOML 表合并到当前配置中；复用已有连接即可。[Codex 插件安装](../README.md#接入-agent)

旧版 Python `kimi-cli` 使用不同的配置目录。若 `kimi --help` 列出 `mcp` 子命令，且确定安装的是旧版，可用 `--host kimi --profile figure-chemistry --install-file "<旧版用户配置目录>/mcp.json"`，配置目录以该版本帮助为准；用 `kimi mcp list` 核对。[旧版 MCP 指南](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/mcp.md)

同一命令可以重复执行。安装器保留其他服务器和配置注释。若已有同名条目但内容不同，先检查它是否指向本项目；需要更新路径或工具范围时，再为同一条命令加 `--replace`。该选项会替换整个 `chem-canvas` 条目。

4. 在源码根目录验证安装的 MCP 进程。此命令会列举实际工具并调用 `canvas_figure` 的只读模式。

```sh
node scripts/plugin-doctor.js --mcp --profile figure-chemistry
```

工具列表应包含 `canvas_figure`、`canvas_put_molecule`、`chemistry_parse`。若返回 `PROJECT_REQUIRED`，用用户打开的画布 URL 中的项目 ID 加 `--project <ID>` 再验。画布默认在 [本机 SVG 工作台](http://127.0.0.1:4317/figure.html)；诊断输出的 `editorUrl` 会带上实际项目。

若 4317 已被其他安装或服务占用，选一个空闲的本机端口，例如 4318，在配置命令和诊断命令中传入相同的 `--url http://127.0.0.1:4318`。修改已写入的条目前先核对当前配置。

5. 最后从**宿主自己的工具列表**调用 `canvas_figure`，参数为 `{"mode":"read","includeImage":false}`。向用户报告实际的项目 ID、修订号和编辑链接。初次使用时空图稿是正常结果。若宿主需要新会话或用户点击信任，先报告本地诊断结果并给出下面的验证口令，待宿主返回工具结果再确认接入成功。

```text
请用 Chem Canvas 的 canvas_figure 只读打开当前项目的图稿，告诉我项目 ID、修订号和编辑链接。
```

普通 Kimi 网页对话与本机 Kimi Code CLI 是不同运行环境。需要从浏览器操作本地工具时，可使用本机 Kimi Code 提供的 Web 界面。纯云端聊天没有本机进程权限时，请选择本地客户端，或由部署方提供该宿主支持且能访问的 MCP 服务。[Kimi Code 的 Web 界面](https://www.kimi.com/code/docs/kimi-code-cli/guides/web.html)

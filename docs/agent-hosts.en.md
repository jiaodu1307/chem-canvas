# Connect your agent to Chem Canvas

[简体中文](agent-hosts.zh-CN.md) · **English**

An agent that supports local **MCP over stdio** can launch Chem Canvas. Your client manages the model, conversation and tool permissions. Chem Canvas stores the project locally, links molecular structures to the drawing and keeps figures and annotations available between sessions. For a standalone SVG or a table of experimental results, you can also ask the agent to produce the file directly.

## Choose your client

For a first installation, send your agent the [installation prompt](install-agent.en.md). To inspect the configuration yourself, use Node.js 24 or newer and run the following commands from the Chem Canvas source directory. Without an installation target, the second command prints the settings for the selected client.

```sh
npm ci
node scripts/plugin-config.js --host cursor --profile figure-chemistry
```

Use `--install-project "<workspace>"` for a supported workspace installer, `--install-user` for a supported user-level installer, or `--install-file "<settings-file>"` for a specific JSON or JSONC file. For TOML, merge the printed tables into the active configuration. Reconnect the client and look for `canvas_figure` in its tool list. Some clients prefix tool names with the server name.

| Client | `--host` | Configuration and verification |
| --- | --- | --- |
| <a id="host-trae" name="host-trae"></a>TRAE IDE (local task or worktree) | `trae` | The project installer writes `.trae/mcp.json`. In Settings → MCP, enable project-level MCP, then enable the server for the active agent. [TRAE IDE guide (Chinese)](https://docs.trae.cn/ide_add-mcp-servers) |
| <a id="host-trae-cli" name="host-trae-cli"></a>TRAE CLI 2.0 | `trae-cli` | Merge the printed table into `~/.trae/traecli.toml` and check with `/mcp`. The launcher receives the profile and project ID as command-line arguments. [TRAE CLI guide (Chinese)](https://docs.trae.cn/cli_config-file) |
| <a id="host-qoder-cn" name="host-qoder-cn"></a>Qoder CN, classic IDE | `qoder-cn` | `--install-user` updates `~/.qoder-cn/mcp.json`. Open Settings → MCP services → My services to inspect the tools. [Chinese IDE guide](https://docs.qoder.cn/user-guide/guide-for-using-mcp) |
| <a id="host-qoder-cli" name="host-qoder-cli"></a>Qoder CLI (international or Chinese edition) | `qoder-cli` | The project installer writes `.qoder/settings.local.json`. Run `qoder mcp list` or `qodercn mcp list` from that workspace. [International CLI guide](https://docs.qoder.com/cli/mcp-servers) · [Chinese CLI guide](https://docs.qoder.cn/cli/mcp-reference) |
| <a id="host-qoder" name="host-qoder"></a>Qoder desktop with Connectors, or the classic international IDE | `qoder` | For the Connectors desktop app, `--install-user` updates `~/.qoder/settings.json`. In the classic international IDE, open Settings → MCP → My Servers → Add and pass the selected file to `--install-file`. [Connectors](https://docs.qoder.com/qoder/connectors) · [Chinese Connectors guide](https://docs.qoder.cn/qoder/connectors) · [Classic IDE guide](https://docs.qoder.com/user-guide/chat/model-context-protocol) |
| <a id="host-kimi" name="host-kimi"></a>Kimi Code CLI | `kimi` | Project installs use `.kimi-code/mcp.json`. User installs use `~/.kimi-code/mcp.json` and respect `KIMI_CODE_HOME`. Trust the workspace, open a new session there and run `/mcp`. [Kimi Code MCP guide](https://www.kimi.com/code/docs/kimi-code-cli/customization/mcp.html) |
| <a id="host-codex" name="host-codex"></a>Codex CLI or desktop, running locally | `codex` | Merge the printed tables under `mcp_servers` in `~/.codex/config.toml`, or reuse the connection from the native Chem Canvas plugin. [Codex MCP guide](https://developers.openai.com/codex/mcp) |
| <a id="host-claude-code" name="host-claude-code"></a>Claude Code | `claude-code` | The project installer writes `.mcp.json` at the workspace root. Run `claude mcp get chem-canvas` to check the connection. [Claude Code guide](https://code.claude.com/docs/en/mcp) |
| <a id="host-claude-desktop" name="host-claude-desktop"></a>Claude Desktop | `claude-desktop` | Open Settings → Developer → Edit Config to locate `claude_desktop_config.json`. [Desktop local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| <a id="host-cursor" name="host-cursor"></a>Cursor | `cursor` | The project file is `.cursor/mcp.json`. For a user-level install, pass `~/.cursor/mcp.json` (using the expanded path) to `--install-file`. [Cursor guide](https://cursor.com/docs/mcp) |
| <a id="host-vscode" name="host-vscode"></a>GitHub Copilot in VS Code | `vscode` | The workspace file is `.vscode/mcp.json`, under `servers`. Use **MCP: List Servers** from the Command Palette. [VS Code guide](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| <a id="host-copilot-cli" name="host-copilot-cli"></a>GitHub Copilot CLI | `copilot-cli` | User configuration lives in `~/.copilot/mcp-config.json` under `mcpServers`. Use the Chem Canvas profile to select its tools. [Copilot CLI guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) |
| <a id="host-gemini" name="host-gemini"></a>Gemini CLI | `gemini` | Project installs update `.gemini/settings.json` under `mcpServers`. Run `/mcp` in the session. [Gemini CLI guide](https://geminicli.com/docs/tools/mcp-server/) |
| <a id="host-opencode" name="host-opencode"></a>OpenCode (versions using `mcp.servers`) | `opencode` | Use `opencode.jsonc` in the workspace. The preset declares a local server with `type: "local"` and a command array. [OpenCode guide](https://opencode.ai/docs/mcp-servers/) |
| <a id="host-zed" name="host-zed"></a>Zed | `zed` | Open Settings → AI → MCP Servers, or merge the entry under `context_servers` in `settings.json`. [Zed guide](https://zed.dev/docs/ai/mcp) |
| <a id="host-generic" name="host-generic"></a>Other local stdio clients | `generic` (default) | The preset emits `mcpServers` JSON. If the client provides a form, copy the executable into `command`, each argument into `args` and each environment variable into `env`. |

The launcher refers to this checkout by absolute path. Regenerate its configuration after moving the source or switching machines. When the Node executable's path contains spaces, the TRAE IDE preset uses `node` from the IDE's PATH.

## Select tools and bind a project

| Profile | Tools |
| --- | --- |
| `figure` | Use `canvas_figure` to read annotations, preview changes, save or export the figure. |
| `figure-chemistry` | Adds `canvas_put_molecule` and `chemistry_parse` for structure entry and parsing. |
| `full` (default) | Also exposes the broader workspace tools, including card references, molecular proposals and revision history. |

Clients that display image results can show the PNG preview in the conversation. Text clients can use the editor and export links returned by the figure tool.

Use `--project <ID>` with the ID from the canvas URL to bind sessions to the same canvas project. The default canvas address is `http://127.0.0.1:4317`. For a second independent checkout, select an available local port, for example `--url http://127.0.0.1:4318`. With WSL, a container or a remote IDE, run Node, the source checkout and the canvas in the environment that launches the MCP process.

### Hand a selected region to another agent

When updating an existing installation, restart the canvas service with the same data directory and reconnect the MCP server in your client to refresh its tool definitions.

Draw a rectangle in the figure editor, save the comment and copy the request into your agent. A second client bound to the same project can read the same note. In `canvas_figure`, read the requested figure and find the note in `figure.reviewNotes`. Pass its ID as `reviewNoteId` in read mode to inspect the current rectangle. Preview the edit and save with the revision you read and a unique operation ID.

To check the result, read the same note with `compareWithCurrent: true`. The two PNGs show the original and current crops in that order. Their revisions are in `comparison.original` and `comparison.current`. The rectangle covers the same relative position on both pages. If the layout moved, locate the feature again on the revised page. A text-only client can use the figure editor to inspect the pair. Export with the verified revision.

DeepSeek DSH workspaces with the native MCP client use the Cordis adapter. Supply your installed DSH workspace, the canvas project ID and a directory for the generated patch, then pass the patch to your host using the launch command printed by the adapter.

```sh
node integrations/deepseek/adapter.mjs --host "<DSH workspace>" --project "<project ID>" --profile figure --output "<patch directory>"
```

## Connect over Streamable HTTP

Start the server on the computer running the canvas.

```sh
node scripts/plugin-http.js --project default --profile figure
```

Replace `default` with the existing canvas project you intend to share. In the client, select **Streamable HTTP** and enter `http://127.0.0.1:4327/mcp`. The launcher checks that the project exists and binds each connection to it. Requests use stateless transport. Writes still use the project revision and operation ID. Use `--port` to change the MCP listener port, or `--url` to select a canvas on the same computer. Stop the command to close the listener.

The listener binds to IPv4 loopback and checks the request Host and browser Origin. To reach it from another machine, the operator needs an authenticated HTTPS gateway that forwards only the `/mcp` path, authorizes the client, validates the external origin and sets the backend Host to loopback. The bridge trusts local connections. The automated tests cover standard Streamable HTTP. Check any hosted client's OAuth requirements separately. For remote export, request `includeSvg: true` to receive the actual SVG. The returned editor and download links point to the canvas computer. [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## What has been verified?

| Scope | Result |
| --- | --- |
| Codex app-server | Loaded the generated TOML in an isolated configuration and discovered `canvas_figure` as the only tool under the `figure` profile. |
| Claude Code 2.0.62 | Registered the generated JSON in an isolated configuration. `claude mcp get chem-canvas` reported `Connected`. |
| Qoder CLI 1.1.97, international edition on Windows | Used the project installer in a temporary workspace. Both `qoder mcp list` and `qoder mcp get chem-canvas` reported `Connected`. The latter confirmed the local settings file, stdio transport and `figure-chemistry` profile. This was a connection check with no model request. |
| Kimi Code 2.7.3 on Windows | Loaded the generated workspace configuration, launched Node, completed the MCP handshake and listed all three `figure-chemistry` tools. |
| DeepSeek DSH 0.2.2-rc.3 and a Kimi project configuration | The native DSH tool registry read the Fujita 5b selection, previewed the SVG edit and saved it. An MCP SDK client launched from the Kimi configuration retrieved byte-identical original and revised crops (revisions 2 and 3) and exported the revised SVG. This check invoked no model. |
| TRAE IDE and CLI 2.0, Qoder CN IDE, Chinese Qoder CLI and Qoder desktop | Verified the configuration format and underlying stdio process. In-client tool calls still await verification. |
| Cursor, Claude Desktop, VS Code with Copilot, GitHub Copilot CLI, Gemini CLI, OpenCode and Zed | Presets follow the linked client configuration formats. In-client verification is pending. |

To check the connection from the actual client, ask it to read the figure and report the project ID, revision and outstanding annotations. An empty figure is a valid result for a new project. [Installation and verification prompt](install-agent.en.md)

Run the project's local transport and configuration checks from the source directory.

```sh
node scripts/plugin-doctor.js --mcp --profile figure-chemistry
node --test tests/plugin-host-config.test.js tests/plugin-doctor.test.js tests/plugin-http.test.js
```

The regression tests launch the configured stdio process from a separate working directory, discover tools and read a figure. They exercise repeated installs, conflicting entries, other servers and JSONC comments. Figure tests save, read back and export SVG using temporary projects and check project isolation. The HTTP tests use the SDK's `StreamableHTTPClientTransport` and check that project mismatches, invalid hosts or origins, cross-site requests and incorrect paths are rejected.

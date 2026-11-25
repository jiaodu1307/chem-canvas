# Ask your agent to install Chem Canvas

[简体中文](install-agent.zh-CN.md) · **English**

Copy this prompt into the coding agent you use on your computer. It also works if you already have a local copy of the repository.

```text
Install Chem Canvas for the agent I am using and verify the connection. The official repository is https://github.com/jiaodu1307/chem-canvas.
Clone it into a directory I can keep, or reuse my existing checkout. Remember which workspace I have open.
Follow docs/install-agent.en.md to identify the client and version. Install the figure-chemistry profile and preserve my existing MCP servers.
Use the agent's canvas_figure tool to read the figure. Report the project ID, revision and editor link.
If I need to enable a setting or start a new session, tell me exactly what to do and give me the verification prompt.
```

## 1. Locate the workspace and the source

Record the absolute path of the workspace the user has open. For project-level installs, the client reads its settings from that workspace. Clone the repository into a directory that will stay in place, or reuse an existing checkout. If the existing checkout predates this guide and contains local changes, clone a fresh copy alongside it.

```sh
git clone https://github.com/jiaodu1307/chem-canvas.git
```

In the environment where the agent runs, check `node --version` and `npm --version`. Chem Canvas requires Node.js 24 or newer. If needed, use the existing Node version manager to install version 24, or use the [Node.js installer](https://nodejs.org/en/download).

Install the dependencies from the Chem Canvas source directory.

```sh
npm ci
```

## 2. Configure the current client

Identify the client and version from the active session, the client's help or its settings. If the client is still ambiguous, ask for its name. Run the relevant command below **from the Chem Canvas source directory**. Replace `<workspace>` with the absolute path recorded in step 1 and keep the quotes. The launcher starts the local canvas on demand.

| Client | Command | Check in the client |
| --- | --- | --- |
| TRAE IDE, local task or worktree | `node scripts/plugin-config.js --host trae --profile figure-chemistry --install-project "<workspace>"` | Under Settings → MCP, enable project-level MCP, then enable the server for the active agent. If the generated command on Windows is `node`, check that the IDE terminal finds Node 24 or newer. |
| TRAE CLI 2.0 | `node scripts/plugin-config.js --host trae-cli --profile figure-chemistry` | Merge the printed `[mcp_servers.chem-canvas]` table into `~/.trae/traecli.toml`. In the CLI session, run `/mcp`. |
| Qoder CN, classic IDE | `node scripts/plugin-config.js --host qoder-cn --profile figure-chemistry --install-user` | In Settings → MCP services → My services, expand `chem-canvas`. Use the tools in agent mode. |
| Qoder CLI, international or Chinese edition | `node scripts/plugin-config.js --host qoder-cli --profile figure-chemistry --install-project "<workspace>"` | From that workspace, run `qoder mcp list` or `qodercn mcp list`. Use `/mcp` in the session. |
| Kimi Code CLI, versions using `.kimi-code` | `node scripts/plugin-config.js --host kimi --profile figure-chemistry --install-project "<workspace>"` | Start a new session in that workspace, trust it when prompted and run `/mcp`. |
| Qoder desktop app with Connectors | `node scripts/plugin-config.js --host qoder --profile figure-chemistry --install-user` | Find `chem-canvas` under Connectors. For the classic international IDE, open Settings → MCP → My Servers → Add, and pass the JSON file it opens to `--install-file "<config-file>"` instead of `--install-user`. |
| Cursor, VS Code with Copilot, Claude Code or Gemini CLI | `node scripts/plugin-config.js --host <host> --profile figure-chemistry --install-project "<workspace>"` | Replace `<host>` with `cursor`, `vscode`, `claude-code` or `gemini`, respectively. Reload MCP in that workspace. |

**Codex.** Reuse the native plugin if it is already connected. To configure the three-tool profile directly, run `node scripts/plugin-config.js --host codex --profile figure-chemistry` and merge both printed TOML tables into the active Codex configuration. The host guide covers other JSON clients and Streamable HTTP. [Codex setup in the README](../README.en.md) · [All supported clients](agent-hosts.en.md)

**Older Python Kimi CLI.** Confirm that this is the older client and that `kimi --help` lists an `mcp` subcommand. Run `node scripts/plugin-config.js --host kimi --profile figure-chemistry --install-file "<legacy-config-dir>/mcp.json"`, using the configuration directory for that version. Check with `kimi mcp list`. [Legacy Kimi CLI guide](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/mcp.md)

You can rerun the same install command. The installer preserves other servers and JSONC comments. If a different entry already uses `chem-canvas`, inspect its path and profile first. When you intend to replace that entire entry, rerun the command with `--replace`.

## 3. Verify the local MCP process

Run the doctor from the source directory. It lists the available tools and calls `canvas_figure` in read mode.

```sh
node scripts/plugin-doctor.js --mcp --profile figure-chemistry
```

The expected tools are `canvas_figure`, `canvas_put_molecule` and `chemistry_parse`. If the result is `PROJECT_REQUIRED`, take the project ID from the user's canvas URL and rerun the command with `--project <ID>`. The doctor's `editorUrl` opens that project. [Default local figure editor](http://127.0.0.1:4317/figure.html)

If another service or checkout is using port 4317, select an available local port. Pass the same `--url http://127.0.0.1:4318` (for example) to the configuration command and the doctor. Inspect any existing entry before replacing it.

## 4. Verify from the agent

From the **client's own tool list**, call `canvas_figure` with `{"mode":"read","includeImage":false}`. Report the actual project ID, revision and editor link. The project ID is also in the `project` query parameter of `editorUrl`. A new project can return an empty figure.

If the client requires workspace trust or a new session, report the local doctor's result and the exact step the user needs to take. Confirm the client connection once it returns its own tool result. The user can paste the following prompt.

```text
Use the Chem Canvas canvas_figure tool to read the current project's figure. Tell me the project ID, revision and editor link.
```

For a browser interface to local Kimi tools, run the web interface included with Kimi Code on the same computer. A hosted chat service needs a reachable MCP endpoint that it supports. [Kimi Code web interface](https://www.kimi.com/code/docs/kimi-code-cli/guides/web.html)

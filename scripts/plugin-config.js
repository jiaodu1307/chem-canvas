import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { toolsForProfile } from '../server/tool-profile.js';
import { projectEndpoint } from '../server/project-binding.js';

const name = 'chem-canvas';
const hosts = ['generic', 'codex', 'claude-code', 'claude-desktop', 'cursor', 'vscode', 'copilot-cli', 'gemini', 'opencode', 'zed', 'trae', 'trae-cli', 'qoder', 'qoder-cn', 'qoder-cli', 'kimi'];
const projectFiles = {
  trae: '.trae/mcp.json', 'qoder-cli': '.qoder/settings.local.json', kimi: '.kimi-code/mcp.json',
  cursor: '.cursor/mcp.json', vscode: '.vscode/mcp.json', 'claude-code': '.mcp.json', gemini: '.gemini/settings.json',
};
const userFiles = {
  'qoder-cn': path.join(os.homedir(), '.qoder-cn', 'mcp.json'),
  qoder: path.join(os.homedir(), '.qoder', 'settings.json'),
  kimi: path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'mcp.json'),
};
const usage = [
  'node scripts/plugin-config.js [--host HOST] [--profile full|figure|figure-chemistry]',
  '                              [--url http://127.0.0.1:4317] [--project PROJECT_ID]',
  '                              [--install-project WORKSPACE | --install-user | --install-file CONFIG.json] [--replace]',
  'Hosts: ' + hosts.join(', ') + '. Default: generic.',
  'Prints a settings fragment by default. Install options merge only the chem-canvas entry.',
  'Project targets: ' + Object.keys(projectFiles).join(', ') + '. --project binds a canvas project ID.',
  'User targets: qoder-cn (CN IDE), qoder (Connectors desktop), kimi (Kimi Code CLI).',
].join('\n');

function settings({ host = 'generic', profile, url = 'http://127.0.0.1:4317', project }) {
  if (!hosts.includes(host)) throw Error('Unknown host: ' + host + '. Choose ' + hosts.join(', ') + '.');
  if (profile !== undefined) toolsForProfile(profile);
  const endpoint = projectEndpoint(url, project);
  const server = {
    command: host === 'trae' && /\s/.test(process.execPath) ? 'node' : process.execPath,
    args: [fileURLToPath(new URL('../server/plugin.js', import.meta.url))],
    env: { CHEM_CANVAS_URL: endpoint.url.origin },
  };
  if (endpoint.projectId) server.env.CHEM_CANVAS_PROJECT_ID = endpoint.projectId;
  if (profile) server.env.CHEM_CANVAS_TOOL_PROFILE = profile;

  if (host === 'trae-cli' || host === 'codex') {
    const args = [...server.args];
    if (host === 'trae-cli') {
      args.push('--url', endpoint.url.origin);
      if (endpoint.projectId) args.push('--project', endpoint.projectId);
      if (profile) args.push('--profile', profile);
    }
    const lines = [
      '[mcp_servers.' + name + ']',
      'command = ' + JSON.stringify(server.command),
      'args = ' + JSON.stringify(args),
    ];
    if (host === 'codex') lines.push(
      '',
      '[mcp_servers.' + name + '.env]',
      ...Object.entries(server.env).map(([key, value]) => key + ' = ' + JSON.stringify(value)),
    );
    return lines.join('\n');
  }
  let config;
  switch (host) {
    case 'vscode': config = { servers: { [name]: { type: 'stdio', ...server } } }; break;
    case 'copilot-cli': config = { mcpServers: { [name]: { type: 'local', ...server, tools: ['*'] } } }; break;
    case 'zed': config = { context_servers: { [name]: server } }; break;
    case 'opencode':
      config = { mcp: { servers: { [name]: {
        type: 'local', command: [server.command, ...server.args], environment: server.env,
      } } } };
      break;
    case 'claude-code': config = { mcpServers: { [name]: { type: 'stdio', ...server } } }; break;
    default: config = { mcpServers: { [name]: server } };
  }
  return JSON.stringify(config, null, 2);
}

try {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' },
    host: { type: 'string' }, profile: { type: 'string' }, project: { type: 'string' }, url: { type: 'string' },
    'install-project': { type: 'string' }, 'install-file': { type: 'string' }, 'install-user': {type:'boolean'}, replace: {type: 'boolean'},
  } });
  if (values.help) {
    console.log(usage);
  } else {
    const fragment = settings(values);
    const workspace = values['install-project'];
    let filename = values['install-file'];
    const targets = [workspace, filename, values['install-user']].filter(value => value !== undefined);
    if (targets.length > 1) throw Error('Choose one install destination.');
    if (values['install-user']) {
      if (!Object.hasOwn(userFiles, values.host)) throw Error('No user-level preset for this host. Specify its settings file with --install-file.');
      filename = userFiles[values.host];
    }
    if (workspace !== undefined || filename !== undefined) {
      if (['trae-cli','codex'].includes(values.host)) throw Error('This host uses TOML. Merge its printed settings into the active TOML configuration.');
      if (workspace !== undefined) {
        if (!Object.hasOwn(projectFiles, values.host)) throw Error('No documented project file for this host. Use --install-file with its actual settings file, or print the fragment.');
        if (!workspace || !(await stat(workspace)).isDirectory()) throw Error('Supply the existing workspace opened in your agent.');
        filename = path.resolve(workspace, projectFiles[values.host]);
      }
      if (!/\.jsonc?$/i.test(filename)) throw Error('Choose a .json or .jsonc configuration file.');
      const {installServer} = await import('./install-mcp-config.js');
      console.log(await installServer(path.resolve(filename), JSON.parse(fragment), values.replace));
    } else {
      if (values.replace) throw Error('--replace requires an install destination.');
      console.log(fragment);
    }
  }
} catch (error) {
  console.error(error.message + '\n' + usage);
  process.exitCode = 1;
}

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { toolsForProfile } from '../server/tool-profile.js';
import { projectEndpoint } from '../server/project-binding.js';

const name = 'chem-canvas';
const hosts = ['generic', 'codex', 'claude-code', 'claude-desktop', 'cursor', 'vscode', 'copilot-cli', 'gemini', 'opencode', 'zed'];
const usage = [
  'node scripts/plugin-config.js [--host HOST] [--profile full|figure|figure-chemistry]',
  '                              [--url http://127.0.0.1:4317] [--project PROJECT_ID]',
  'Hosts: ' + hosts.join(', ') + '. Default: generic.',
  'Prints a settings fragment for this checkout; merge it into the host configuration.',
].join('\n');

function settings({ host = 'generic', profile, url = 'http://127.0.0.1:4317', project }) {
  if (!hosts.includes(host)) throw Error('Unknown host: ' + host + '. Choose ' + hosts.join(', ') + '.');
  if (profile !== undefined) toolsForProfile(profile);
  const endpoint = projectEndpoint(url, project);
  const server = {
    command: process.execPath,
    args: [fileURLToPath(new URL('../server/plugin.js', import.meta.url))],
    env: { CHEM_CANVAS_URL: endpoint.url.origin },
  };
  if (endpoint.projectId) server.env.CHEM_CANVAS_PROJECT_ID = endpoint.projectId;
  if (profile) server.env.CHEM_CANVAS_TOOL_PROFILE = profile;

  if (host === 'codex') {
    return [
      '[mcp_servers.' + name + ']',
      'command = ' + JSON.stringify(server.command),
      'args = ' + JSON.stringify(server.args),
      '',
      '[mcp_servers.' + name + '.env]',
      ...Object.entries(server.env).map(([key, value]) => key + ' = ' + JSON.stringify(value)),
    ].join('\n');
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
  } });
  console.log(values.help ? usage : settings(values));
} catch (error) {
  console.error(error.message + '\n' + usage);
  process.exitCode = 1;
}

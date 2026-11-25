import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { profileArgs } from '../../server/tool-profile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const packageInfo = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
if (packageInfo.name !== 'chem-canvas') throw new Error('Expected the Chem Canvas checkout.');
const options = profileArgs(process.argv.slice(2));
if (options.args.length > 1) throw new Error('Usage: node integrations/codex/prepare.mjs [loopback-origin] [--profile full|figure|figure-chemistry]');
const endpoint = new URL(options.args[0] || 'http://127.0.0.1:4317');
if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
  throw new Error('Supply a plain loopback HTTP origin, for example http://127.0.0.1:4317.');
}
const servers = {
  'chem-canvas': {
    // Agent Plugins portable stdio config rejects absolute executable paths.
    command: 'node',
    args: [path.join(projectRoot, 'server', 'plugin.js')],
    env: { CHEM_CANVAS_URL: endpoint.origin, ...options.env }
  }
};
const plugin = path.join(here, 'plugin');
await mkdir(plugin, { recursive: true });
await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
await writeFile(path.join(plugin, 'mcp.json'), JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { 'chem-canvas': { type: 'stdio', ...servers['chem-canvas'] } }
}, null, 2) + '\n');
console.log(JSON.stringify({ marketplaceRoot: here, plugin, runtime: servers['chem-canvas'].args[0], endpoint: endpoint.origin }, null, 2));

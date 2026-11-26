import { createRequire } from 'node:module';
import { realpathSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProjectId } from '../../server/project-binding.js';
import { toolsForProfile } from '../../server/tool-profile.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export async function discoverCatalog(config) {
  assert.ok(config.env.CHEM_CANVAS_URL, 'Discovery requires an explicit running canvas');
  const client = new Client({ name: 'deepseek-schema-check', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: 'ignore' }));
    const tools = []; let cursor;
    do { const page = await client.listTools({ cursor }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    const expected = toolsForProfile(config.env.CHEM_CANVAS_TOOL_PROFILE);
    const names = tools.map(tool => tool.name);
    if (expected) assert.deepEqual(names.sort(), [...expected].sort(), 'Unexpected tools in the selected profile');
    else assert.ok(names.includes('canvas_read'));
    return tools;
  } finally { await client.close(); }
}
export function verifyRegistry(registry, catalog, agent) {
  const names = registry.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('mcp__chem_canvas__')).sort();
  assert.deepEqual(names, catalog.map(tool => `mcp__chem_canvas__${tool.name}`).sort());
  for (const tool of catalog) assert.deepEqual(registry.get(`mcp__chem_canvas__${tool.name}`).parameters, tool.inputSchema, tool.name);
  return names;
}

// Read installed package metadata only. Never inspect host profiles or credentials.
export function discoverHost(hostRoot = path.resolve(projectRoot, '../deepseek/chem-workbench')) {
  const manifest = realpathSync(path.join(hostRoot, 'node_modules/@deepseek-ai/dsh/package.json'));
  const resolve = createRequire(manifest).resolve;
  return {
    root: path.resolve(hostRoot), version: JSON.parse(readFileSync(manifest, 'utf8')).version,
    cli: path.join(path.dirname(manifest), 'lib/bin.js'),
    mcpClient: resolve('@deepseek-ai/dsh-mcp-client'),
    tools: resolve('@deepseek-ai/dsh-tools'),
    systemPrompt: resolve('@deepseek-ai/dsh-system-prompt'),
    cordis: resolve('@deepseek-ai/cordis'),
  };
}
export function buildConfig({ url, projectId, profile, entry = path.join(projectRoot, 'server/plugin.js'), node = process.execPath } = {}) {
  toolsForProfile(profile);
  if (url !== undefined) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Canvas URL must be a plain loopback HTTP origin.');
  }
  return {
    serverName: 'chem_canvas', transport: 'stdio', command: node,
    args: [path.resolve(entry)], cwd: projectRoot,
    env: { ...(url === undefined ? {} : { CHEM_CANVAS_URL: new URL(url).origin }),
      ...(projectId === undefined ? {} : { CHEM_CANVAS_PROJECT_ID: validateProjectId(projectId) }),
      ...(profile === undefined ? {} : { CHEM_CANVAS_TOOL_PROFILE: profile }) },
    startupTimeoutMs: 30000, toolCallTimeoutMs: 60000, closeTimeoutMs: 5000,
    expandTemplates: false, failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 10000, maxAttempts: 5 },
  };
}
export function buildPatch(host, config = buildConfig()) {
  // JSON is valid YAML; this is the exact patch-array form used by host scripts/runtime.mjs.
  return [{ insert: [{ id: 'chem-canvas-mcp', name: host.mcpClient, config }] }];
}
export async function loadHostModules(host) {
  const [cordis, tools, systemPrompt, mcp] = await Promise.all([host.cordis, host.tools, host.systemPrompt, host.mcpClient].map(file => import(pathToFileURL(file).href)));
  return { cordis, tools, systemPrompt, mcp };
}
export function generate({ hostRoot, url, projectId, profile, entry, output = path.join(projectRoot, 'integrations/deepseek/generated') } = {}) {
  const host = discoverHost(hostRoot), config = buildConfig({ url, projectId, profile, entry });
  mkdirSync(output, { recursive: true });
  const patchPath = path.join(output, 'chem-canvas.patch.json');
  writeFileSync(patchPath, JSON.stringify(buildPatch(host, config), null, 2) + '\n');
  const entryPath = path.join(output, 'chem-canvas.entry.json');
  writeFileSync(entryPath, JSON.stringify(buildPatch(host, config)[0].insert[0], null, 2) + '\n');
  return { hostVersion: host.version, patchPath, entryPath, command: [process.execPath, host.cli, '--profile', 'web', '--patch', patchPath, '--no-open'], discovery: 'native MCP tools/list at connection time' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const option = ({ '--host': 'hostRoot', '--url': 'url', '--project': 'projectId', '--profile': 'profile', '--output': 'output' })[process.argv[i]];
    if (!option || !process.argv[i + 1]) throw new Error('Usage: node integrations/deepseek/adapter.mjs [--host PATH] [--url http://127.0.0.1:PORT] [--project ID] [--profile full|figure|figure-chemistry] [--output PATH]');
    options[option] = process.argv[i + 1];
  }
  console.log(JSON.stringify(generate(options), null, 2));
}

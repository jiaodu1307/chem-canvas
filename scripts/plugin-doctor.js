import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { pluginSettings, probeCanvas } from '../server/plugin-runtime.js';
import { toolsForProfile } from '../server/tool-profile.js';

const usage = 'node scripts/plugin-doctor.js [--mcp] [--profile full|figure|figure-chemistry] [--url URL] [--project PROJECT_ID]';
const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' }, mcp: { type: 'boolean' },
  profile: { type: 'string' }, url: { type: 'string' }, project: { type: 'string' },
} });
if (values.help) { console.log(usage); process.exit(0); }

async function checkMcp(settings, profile) {
  const expected = toolsForProfile(profile);
  const script = fileURLToPath(new URL('./plugin-config.js', import.meta.url));
  const args = [script, '--profile', profile, '--url', settings.url];
  if (settings.projectId) args.push('--project', settings.projectId);
  const { mcpServers } = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  const server = mcpServers['chem-canvas'];
  if (settings.explicitData) server.env.CHEM_CANVAS_DATA_DIR = settings.dataDirectory;
  if (!settings.autoStart) server.env.CHEM_CANVAS_AUTOSTART = '0';

  // A basic doctor must still run before npm ci, when these modules are missing.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'chem-canvas-doctor', version: '1' });
  try {
    await client.connect(new StdioClientTransport(server));
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    if (!tools.includes('canvas_figure') || (expected && (tools.length !== expected.length || !expected.every(name => tools.includes(name))))) {
      throw new Error('The MCP tool list differs from the requested profile: ' + tools.join(', '));
    }
    const reply = await client.callTool({ name: 'canvas_figure', arguments: { mode: 'read', includeImage: false } });
    const result = JSON.parse(reply.content[0].text);
    if (reply.isError) {
      if (result.error.code === 'PROJECT_REQUIRED' && !settings.projectId) {
        return { profile, tools, status: 'PROJECT_REQUIRED', projects: result.error.projects.map(project => project.id),
          hint: 'Connected. Repeat with --project PROJECT_ID to read the intended project.' };
      }
      throw new Error(result.error.code + ': ' + result.error.message);
    }
    if (!Number.isSafeInteger(result.revision) || !Object.hasOwn(result, 'figure')) throw new Error('Invalid figure read response.');
    return { profile, tools, status: 'read', revision: result.revision, editorUrl: result.editorUrl,
      projectId: result.projectId ?? new URL(result.editorUrl).searchParams.get('project') };
  } finally {
    await client.close();
  }
}

const checks = [];
checks.push({ name: 'Node.js >= 24', ok: Number(process.versions.node.split('.')[0]) >= 24, value: process.version });
for (const file of ['../node_modules/@rdkit/rdkit/package.json', '../node_modules/@modelcontextprotocol/sdk/package.json']) {
  let ok = true; try { await access(new URL(file, import.meta.url)); } catch { ok = false; }
  checks.push({ name: file.includes('rdkit') ? 'RDKit installed' : 'MCP SDK installed', ok });
}
let settings;
try {
  const env = { ...process.env };
  if (values.url !== undefined) env.CHEM_CANVAS_URL = values.url;
  if (values.project !== undefined) env.CHEM_CANVAS_PROJECT_ID = values.project;
  settings = pluginSettings(env);
  const service = await probeCanvas(settings.url);
  checks.push({ name: 'Local canvas', ok: true, value: service ? `${settings.url} (running)` : `${settings.url} (will start on first tool connection)` });
  checks.push({ name: 'Plugin entry', ok: true, value: fileURLToPath(new URL('../server/plugin.js', import.meta.url)) });
} catch (error) { checks.push({ name: 'Local canvas', ok: false, value: error.message }); }
if (values.mcp && checks.every(check => check.ok)) {
  try {
    const profile = values.profile ?? process.env.CHEM_CANVAS_TOOL_PROFILE ?? 'full';
    checks.push({ name: 'MCP stdio', ok: true, value: await checkMcp(settings, profile) });
  } catch (error) { checks.push({ name: 'MCP stdio', ok: false, value: error.message }); }
}
console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks }, null, 2));
if (checks.some(c => !c.ok)) process.exitCode = 1;

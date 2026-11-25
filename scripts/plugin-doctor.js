import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pluginSettings, probeCanvas } from '../server/plugin-runtime.js';
const checks = [];
checks.push({ name: 'Node.js >= 24', ok: Number(process.versions.node.split('.')[0]) >= 24, value: process.version });
for (const file of ['../node_modules/@rdkit/rdkit/package.json', '../node_modules/@modelcontextprotocol/sdk/package.json']) {
  let ok = true; try { await access(new URL(file, import.meta.url)); } catch { ok = false; }
  checks.push({ name: file.includes('rdkit') ? 'RDKit installed' : 'MCP SDK installed', ok });
}
try {
  const settings = pluginSettings();
  const service = await probeCanvas(settings.url);
  checks.push({ name: 'Local canvas', ok: true, value: service ? `${settings.url} (running)` : `${settings.url} (will start on first tool connection)` });
  checks.push({ name: 'Plugin entry', ok: true, value: fileURLToPath(new URL('../server/plugin.js', import.meta.url)) });
} catch (error) { checks.push({ name: 'Local canvas', ok: false, value: error.message }); }
console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks }, null, 2));
if (checks.some(c => !c.ok)) process.exitCode = 1;

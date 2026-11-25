import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectEndpoint } from './project-binding.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function pluginSettings(env = process.env) {
  const { url, projectId } = projectEndpoint(env.CHEM_CANVAS_URL || `http://127.0.0.1:${env.CHEM_CANVAS_PORT || 4317}`, env.CHEM_CANVAS_PROJECT_ID);
  const dataDirectory = path.resolve(projectRoot, env.CHEM_CANVAS_DATA_DIR || '.local/workspace');
  return { url: url.origin, port: Number(url.port || 80), dataDirectory, ...(projectId === undefined ? {} : {projectId}), explicitData: !!env.CHEM_CANVAS_DATA_DIR, autoStart: env.CHEM_CANVAS_AUTOSTART !== '0' };
}

export async function probeCanvas(url) {
  let response;
  try { response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200), redirect: 'error' }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw Error(`Cannot inspect canvas at ${url}: ${error.message}`);
  }
  const info = await response.json().catch(() => null);
  if (!response.ok || info?.service !== 'chem-canvas') throw Error(`Port at ${url} is occupied by another service; choose CHEM_CANVAS_URL explicitly.`);
  return info;
}

function checkIdentity(info, settings) {
  const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (info.projectRoot && normalized(info.projectRoot) !== normalized(projectRoot)) throw Error('The canvas at this port belongs to another installation. Choose a different port.');
  if (settings.explicitData && (!info.dataDirectory || normalized(info.dataDirectory) !== normalized(settings.dataDirectory))) throw Error('The running canvas uses a different data directory. It was left untouched.');
}

export async function ensureCanvas({ env = process.env } = {}) {
  const settings = pluginSettings(env);
  const existing = await probeCanvas(settings.url);
  if (existing) { checkIdentity(existing, settings); return { ...settings, started: false, pid: existing.pid }; }
  if (!settings.autoStart) throw Error(`Canvas is not running at ${settings.url}. Start npm start or enable automatic startup.`);
  const runtimeDirectory = path.join(projectRoot, '.local', 'runtime');
  await mkdir(runtimeDirectory, { recursive: true });
  const logPath = path.join(runtimeDirectory, `canvas-${settings.port}.log`);
  const log = await open(logPath, 'a');
  let child, spawnError;
  try {
    child = spawn(process.execPath, [path.join(projectRoot, 'server', 'index.js')], {
      cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...env, CHEM_CANVAS_PORT: String(settings.port), CHEM_CANVAS_DATA_DIR: settings.dataDirectory }
    });
    child.once('error', error => { spawnError = error; }); child.unref();
  } finally { await log.close(); }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnError) throw Error(`Canvas startup failed: ${spawnError.message}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const info = await probeCanvas(settings.url);
    if (info) { checkIdentity(info, settings); return { ...settings, started: info.pid === child.pid, pid: info.pid, logPath }; }
    if (child.exitCode !== null && child.exitCode !== undefined) break;
  }
  throw Error(`Canvas did not start at ${settings.url}. Inspect ${logPath}; existing data was not reset.`);
}

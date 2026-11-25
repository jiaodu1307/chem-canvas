import {randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, realpath, rename, stat, unlink} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {applyEdits, getNodeValue, modify, parseTree, stripComments} from 'jsonc-parser';

const serverName = 'chem-canvas';

function mergeServer(source, fragment, replace) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  let body = source.slice(bom.length);
  if (!stripComments(body).trim()) {
    const eol = body.includes('\r\n') ? '\r\n' : '\n';
    if (body && !body.endsWith('\n')) body += eol;
    body += '{}' + eol;
  }
  const errors = [];
  let node = parseTree(body, errors, {allowTrailingComma:true});
  if (errors.length || node?.type !== 'object') throw Error('Expected a valid JSON or JSONC settings object.');

  // Follow the single path in the host-specific fragment, e.g. mcpServers → chem-canvas.
  const keys = [];
  let value = fragment;
  do {
    const [key] = Object.keys(value);
    keys.push(key);
    value = value[key];
    if (!node) continue;
    if (node.type !== 'object') throw Error('Expected a settings object at ' + keys.slice(0,-1).join('.'));
    const matches = node.children.filter(property => property.children[0].value === key);
    if (matches.length > 1) throw Error('Duplicate configuration key: ' + keys.join('.'));
    node = matches[0]?.children[1];
  } while (keys.at(-1) !== serverName);

  if (node) {
    if (isDeepStrictEqual(JSON.parse(JSON.stringify(getNodeValue(node))), value)) return source;
    if (!replace) throw Error('A different chem-canvas entry already exists. Review it before using --replace.');
  }
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = body.match(/\n([ \t]+)"/)?.[1] || '  ';
  const formattingOptions = {insertSpaces: !indent.includes('\t'), tabSize: indent.length, eol};
  return bom + applyEdits(body, modify(body, keys, value, {formattingOptions}));
}

async function existingText(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function installServer(filename, fragment, replace = false) {
  await mkdir(path.dirname(filename), {recursive:true});
  // Follow an existing settings symlink so replacing its contents preserves the link.
  const info = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info?.isSymbolicLink()) filename = await realpath(filename);
  const lock = filename + '.chem-canvas.lock';
  const handle = await open(lock, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw Error('Configuration is locked by another install: ' + lock);
    throw error;
  });
  const temp = filename + '.chem-canvas-' + randomUUID() + '.tmp';
  try {
    const before = await existingText(filename);
    const updated = mergeServer(before ?? '{}\n', fragment, replace);
    if (updated === before) return 'Already configured: ' + filename;
    const mode = before === null ? 0o600 : (await stat(filename)).mode & 0o777;
    const output = await open(temp, 'wx', mode);
    try {
      await output.writeFile(updated, 'utf8');
      await output.chmod(mode);
    } finally { await output.close(); }
    if (await existingText(filename) !== before) throw Error('The settings file changed during installation. Retry with the latest file.');
    await rename(temp, filename);
    return 'Installed chem-canvas: ' + filename;
  } finally {
    try { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await handle.close(); await unlink(lock); }
  }
}

import path from 'node:path';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { failure } from './store.js';

export const MAX_STRUCTURE_RESOURCE_BYTES = 1024 * 1024;
const LIST_LIMIT = 200;

// This is a deliberately narrow staging area, not a general filesystem API.
export class StructureResources {
  constructor(dataDirectory, format = 'mol') {
    if (!['mol', 'xlsx'].includes(format)) throw failure('VALIDATION', '不支持的导入格式。');
    this.format = format;
    this.byteLimit = format === 'xlsx' ? 8 * 1024 * 1024 : MAX_STRUCTURE_RESOURCE_BYTES;
    this.directory = path.resolve(dataDirectory, 'imports');
  }

  async root() {
    try {
      const stat = await lstat(this.directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('FORBIDDEN', '结构资源目录必须为真实目录。');
      return await realpath(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list() {
    const root = await this.root();
    if (!root) return { resources: [], truncated: false, limit: LIST_LIMIT };
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.' + this.format)
      .sort((a, b) => a.name.localeCompare(b.name));
    const resources = [];
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      try {
        const { source } = await this.read(entry.name);
        const { kind, ...metadata } = source;
        resources.push(metadata);
      } catch (error) {
        // A changed, oversized or unavailable resource is not an import candidate.
        if (!['NOT_FOUND', 'FORBIDDEN', 'TOO_LARGE', 'VALIDATION', 'CONFLICT'].includes(error.code)) throw error;
      }
    }
    return { resources, truncated: entries.length > LIST_LIMIT, limit: LIST_LIMIT };
  }

  async read(resourceId, { expectedSha256 } = {}) {
    if (typeof resourceId !== 'string' || resourceId.length > 255 ||
        path.extname(resourceId).toLowerCase() !== '.' + this.format || /[\\/:\x00-\x1f]/.test(resourceId) ||
        resourceId === '.' || resourceId === '..' || resourceId.endsWith(' ') ||
        path.basename(resourceId) !== resourceId) {
      throw failure('VALIDATION', 'resourceId 必须是导入目录中的 ' + this.format.toUpperCase() + ' 文件名。');
    }
    if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
      throw failure('VALIDATION', 'expectedSha256 必须为 64 位小写 SHA-256。');
    }
    const root = await this.root();
    if (!root) throw failure('NOT_FOUND', '资源不存在。请先将文件放入项目的 imports 目录。');
    const filename = path.join(root, resourceId);
    let handle;
    try {
      const before = await lstat(filename);
      if (before.isSymbolicLink() || !before.isFile() || path.dirname(await realpath(filename)) !== root) {
        throw failure('FORBIDDEN', '结构资源必须为导入目录内的真实文件。');
      }
      if (before.size > this.byteLimit) throw failure('TOO_LARGE', '导入文件超过大小限制。');
      handle = await open(filename, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw failure('CONFLICT', '资源在读取时发生变化，请重新列出资源。');
      if (opened.size > this.byteLimit) throw failure('TOO_LARGE', '导入文件超过大小限制。');
      // Bounded read also protects against a file growing after stat().
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > this.byteLimit) throw failure('TOO_LARGE', '导入文件超过大小限制。');
      if (length !== opened.size) throw failure('CONFLICT', '文件大小已变化，请重新读取。');
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw failure('CONFLICT', '资源在读取时发生变化，请重新列出资源。');
      const bytes = buffer.subarray(0, length);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (expectedSha256 !== undefined && expectedSha256 !== sha256) throw failure('CONFLICT', '资源内容已变化，请重新列出资源并检查。');
      if (this.format === 'xlsx') return { bytes, source: { kind: 'workbook', resourceId, format: 'xlsx', bytes: length, sha256 } };
      let molblock;
      try { molblock = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw failure('VALIDATION', 'MOL 资源必须为 UTF-8 文本。'); }
      if (!molblock.trim() || molblock.includes('\0')) throw failure('VALIDATION', 'MOL 资源不能为空或包含 NUL 字节。');
      return { molblock, source: { kind: 'structure-resource', resourceId, format: 'mol', bytes: length, sha256 } };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw failure('NOT_FOUND', '结构资源不存在。');
      if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw failure('FORBIDDEN', '结构资源不可访问。');
      throw error;
    } finally { await handle?.close(); }
  }
}

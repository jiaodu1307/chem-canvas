import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDocument, validateDocument } from '../src/core/index.js';

export function failure(code, message) { return Object.assign(new Error(message), { code }); }

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export class DocumentStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'document.json');
    this.lockFile = path.join(this.directory, 'writer.lock');
    this.queue = Promise.resolve();
    this.lock = null;
  }

  async start() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.lock = await open(this.lockFile, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover a lock only when its recorded process is definitely gone.
      const pid = Number(await readFile(this.lockFile, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw failure('LOCKED', '存储锁无法识别，请检查是否已有服务运行。');
      try { process.kill(pid, 0); throw failure('LOCKED', `数据目录已由进程 ${pid} 使用。`); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
      await unlink(this.lockFile);
      this.lock = await open(this.lockFile, 'wx');
    }
    await this.lock.writeFile(String(process.pid));
    try {
      try {
        const envelope = JSON.parse(await readFile(this.file, 'utf8'));
        validateDocument(envelope.document);
        if (!envelope.receipts || typeof envelope.receipts !== 'object' || Array.isArray(envelope.receipts)) throw failure('VALIDATION', '存储回执无效。');
        this.document = envelope.document;
        this.receipts = envelope.receipts;
      } catch (error) {
        if (error.code !== 'ENOENT') throw failure('STORAGE', `无法读取已有研究文档，已停止以保护数据：${error.message}`);
        this.document = createDocument({ id: randomUUID(), title: '未命名研究' });
        this.receipts = {};
        await this.persist(this.document, this.receipts);
      }
    } catch (error) { await this.close(); throw error; }
    return this;
  }

  async persist(document, receipts) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify({ format: 'chem-canvas-store/1', document, receipts })); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw failure('STORAGE', `文档未保存：${error.message}`);
    }
  }

  mutate(route, request, transform) {
    const job = this.queue.then(async () => {
      const id = request?.operationId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id) || ['__proto__','prototype','constructor'].includes(id)) throw failure('VALIDATION', '需要有效的 operationId。');
      const signature = stableJson({ route, request });
      if (Object.hasOwn(this.receipts, id)) {
        if (this.receipts[id] !== signature) throw failure('CONFLICT', '该 operationId 已用于不同请求。');
        return { document: this.document, replayed: true };
      }
      if (request.expectedRevision !== this.document.revision) throw failure('CONFLICT', '文档已变化，请重新读取后调整修改。');
      const next = await transform(this.document);
      validateDocument(next);
      const receipts = { ...this.receipts, [id]: signature };
      await this.persist(next, receipts);
      this.document = next;
      this.receipts = receipts;
      return { document: next };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async close() {
    await this.queue;
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.lockFile).catch(() => {}); }
  }
}

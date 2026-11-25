import path from 'node:path';
import { lstat, mkdir, readFile, realpath, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DocumentStore, failure, stableJson } from './store.js';
import { StructureResources } from './structure-resources.js';

const projectPattern = /^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const taskPattern = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const validRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
function operationId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value) || reserved.has(value)) throw failure('VALIDATION', '需要有效的 operationId。');
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 240) throw failure('VALIDATION', '标题需要 1 至 240 个字符。');
  return value.trim();
}
async function regularFile(file, optional = false) {
  const stat = await lstat(file).catch(error => { if (optional && error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw failure('STORAGE', '工作区文件必须是普通本地文件。');
  return Boolean(stat);
}
async function metadata(file, optional = true) {
  if (!await regularFile(file, optional)) return null;
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!validRecord(value)) throw new Error('Expected metadata object');
    return value;
  }
  catch { throw failure('STORAGE', '工作区元数据无法读取，已停止以保护现有内容。'); }
}
async function atomicWrite(file, value) {
  await regularFile(file, true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** One registry per existing writer lock. Project identity is request-scoped, never active-global. */
export class ProjectWorkspaces {
  constructor(defaultStore) {
    this.defaultStore = defaultStore;
    this.directory = defaultStore.directory;
    this.catalogFile = path.join(this.directory, 'projects.json');
    this.projects = new Map();
    this.catalog = { format: 'chem-canvas-projects/1', projects: [], receipts: {} };
    this.queue = Promise.resolve();
  }

  async start() {
    try {
      this.realDirectory = await realpath(this.directory);
      await this.attach('default', null, this.defaultStore);
      const saved = await metadata(this.catalogFile);
      if (saved) {
        if (saved.format !== 'chem-canvas-projects/1' || !Array.isArray(saved.projects) || !validRecord(saved.receipts)) throw failure('STORAGE', '项目目录格式无效。');
        const seen = new Set();
        for (const entry of saved.projects) {
          if (!validRecord(entry) || !projectPattern.test(entry.id) || seen.has(entry.id) || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 240) throw failure('STORAGE', '项目目录记录无效。');
          seen.add(entry.id);
        }
        for (const [key, receipt] of Object.entries(saved.receipts)) {
          if (reserved.has(key) || !validRecord(receipt) || typeof receipt.signature !== 'string' || !seen.has(receipt.projectId)) throw failure('STORAGE', '项目目录回执无效。');
        }
        this.catalog = saved;
        for (const entry of saved.projects) {
          const directory = await this.projectDirectory(entry.id, false);
          // Never recreate a catalogued document when a file goes missing.
          await regularFile(path.join(directory, 'document.json'));
          const store = await new DocumentStore(directory).start();
          try { await this.attach(entry.id, entry.title, store); }
          catch (error) { await store.close(); throw error; }
        }
      }
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  async projectDirectory(id, create) {
    if (!projectPattern.test(id)) throw failure('VALIDATION', '项目标识无效。');
    let current = this.directory;
    for (const segment of ['projects', id]) {
      current = path.join(current, segment);
      if (create) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('STORAGE', '项目目录不能是链接或其他文件。');
      const resolved = await realpath(current);
      if (!resolved.startsWith(this.realDirectory + path.sep)) throw failure('STORAGE', '项目目录超出工作区。');
    }
    return current;
  }

  async prepare(id, projectTitle, store) {
    const file = path.join(store.directory, 'workspace.json');
    const saved = await metadata(file);
    const state = saved ?? { format: 'chem-canvas-workspace/1', version: 0, currentTaskId: null, tasks: [], receipts: {} };
    this.validateWorkspace(state);
    return { id, title: projectTitle, store, resources: new StructureResources(store.directory), selection: { objectIds: [], revision: store.document.revision }, depictions: new Map(), workspace: state, workspaceFile: file, queue: Promise.resolve() };
  }

  async attach(id, projectTitle, store) {
    this.projects.set(id, await this.prepare(id, projectTitle, store));
  }

  validateWorkspace(state) {
    if (!validRecord(state) || state.format !== 'chem-canvas-workspace/1' || !Number.isSafeInteger(state.version) || state.version < 0 || !Array.isArray(state.tasks) || !validRecord(state.receipts)) throw failure('STORAGE', '任务工作区格式无效。');
    const ids = new Set();
    for (const task of state.tasks) {
      if (!validRecord(task) || !taskPattern.test(task.id) || ids.has(task.id) || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 240 || !['active', 'archived'].includes(task.status) || !Array.isArray(task.objectIds) || task.objectIds.length > 200 || new Set(task.objectIds).size !== task.objectIds.length || task.objectIds.some(id => typeof id !== 'string' || !id || reserved.has(id))) throw failure('STORAGE', '任务记录无效。');
      ids.add(task.id);
    }
    if (state.currentTaskId !== null && !state.tasks.some(task => task.id === state.currentTaskId && task.status === 'active')) throw failure('STORAGE', '当前任务引用无效。');
    if (Object.entries(state.receipts).some(([key, value]) => reserved.has(key) || typeof value !== 'string')) throw failure('STORAGE', '任务回执无效。');
  }

  get(id = 'default') {
    if (id !== 'default' && (typeof id !== 'string' || !projectPattern.test(id))) throw failure('VALIDATION', '项目标识无效。');
    const project = this.projects.get(id);
    if (!project) throw failure('NOT_FOUND', '项目不存在，请从项目列表重新选择。');
    return project;
  }

  fromSearchParams(params) {
    if (params.getAll('project').length > 1) throw failure('VALIDATION', '一次请求只能绑定一个项目。');
    return this.get(params.has('project') ? params.get('project') : 'default');
  }

  descriptor(project) { return { id: project.id, title: project.title ?? project.store.document.title, documentId: project.store.document.id, revision: project.store.document.revision }; }
  list() { return { projects: [...this.projects.values()].map(project => this.descriptor(project)), defaultProjectId: 'default' }; }

  create(input) {
    const job = this.queue.then(async () => {
      if (!validRecord(input) || Object.keys(input).some(key => !['title', 'operationId'].includes(key))) throw failure('VALIDATION', '新建项目仅接受标题和 operationId。');
      operationId(input.operationId);
      const projectTitle = title(input.title), signature = stableJson(input);
      if (has(this.catalog.receipts, input.operationId)) {
        const receipt = this.catalog.receipts[input.operationId];
        if (receipt.signature !== signature) throw failure('CONFLICT', '该 operationId 已用于不同的新建项目请求。');
        return { project: this.descriptor(this.get(receipt.projectId)), replayed: true };
      }
      const id = `project-${randomUUID()}`, directory = await this.projectDirectory(id, true);
      const store = await new DocumentStore(directory).start();
      try {
        const document = { ...store.document, title: projectTitle };
        await store.persist(document, store.receipts); store.document = document;
        const next = { ...this.catalog, projects: [...this.catalog.projects, { id, title: projectTitle }], receipts: { ...this.catalog.receipts, [input.operationId]: { signature, projectId: id } } };
        const project = await this.prepare(id, projectTitle, store);
        await atomicWrite(this.catalogFile, next);
        this.catalog = next;
        this.projects.set(id, project);
        return { project: this.descriptor(this.get(id)) };
      } catch (error) { this.projects.delete(id); await store.close(); throw error; }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  workspace(project) {
    const { version, currentTaskId, tasks } = project.workspace;
    return { projectId: project.id, version, currentTaskId, tasks: tasks.map(task => ({ ...task, objectIds: [...task.objectIds], missingObjectIds: task.objectIds.filter(id => !has(project.store.document.objects, id)) })) };
  }

  updateTask(project, input) {
    const job = project.queue.then(async () => {
      if (!validRecord(input) || Object.keys(input).some(key => !['operationId', 'expectedVersion', 'action', 'taskId', 'title', 'objectIds'].includes(key))) throw failure('VALIDATION', '任务请求包含未知字段。');
      operationId(input.operationId);
      const signature = stableJson(input), state = project.workspace;
      if (has(state.receipts, input.operationId)) {
        if (state.receipts[input.operationId] !== signature) throw failure('CONFLICT', '该 operationId 已用于不同任务请求。');
        return { ...this.workspace(project), replayed: true };
      }
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw failure('VALIDATION', '需要有效的任务工作区版本。');
      if (input.expectedVersion !== state.version) throw failure('CONFLICT', '任务工作区已变化，请重新读取。');
      if (!['create', 'update', 'activate', 'archive'].includes(input.action)) throw failure('VALIDATION', '任务操作无效。');
      if (input.action === 'create' && input.taskId !== undefined) throw failure('VALIDATION', '新任务标识由服务端生成。');
      if (['activate', 'archive'].includes(input.action) && (input.title !== undefined || input.objectIds !== undefined)) throw failure('VALIDATION', '切换或归档任务不能同时修改任务内容。');
      const next = structuredClone(state);
      let task;
      if (input.action === 'create') {
        task = { id: `task-${randomUUID()}`, title: title(input.title), objectIds: [], status: 'active' };
        next.tasks.push(task); next.currentTaskId = task.id;
      } else {
        if (typeof input.taskId !== 'string' || !taskPattern.test(input.taskId)) throw failure('VALIDATION', '需要有效任务标识。');
        task = next.tasks.find(task => task.id === input.taskId);
        if (!task) throw failure('NOT_FOUND', '该项目中不存在此任务。');
      }
      if (input.action === 'update' && input.title === undefined && input.objectIds === undefined) throw failure('VALIDATION', '更新任务需要标题或结构范围。');
      if (input.title !== undefined) task.title = title(input.title);
      if (input.objectIds !== undefined) {
        if (!Array.isArray(input.objectIds) || input.objectIds.length > 200 || new Set(input.objectIds).size !== input.objectIds.length || input.objectIds.some(id => typeof id !== 'string' || !id || reserved.has(id))) throw failure('VALIDATION', '任务范围需要至多 200 个不重复的对象标识。');
        if (input.objectIds.some(id => !has(project.store.document.objects, id))) throw failure('NOT_FOUND', '任务范围包含不属于本项目的已保存对象。');
        task.objectIds = [...input.objectIds];
      }
      if (input.action === 'activate') { task.status = 'active'; next.currentTaskId = task.id; }
      if (input.action === 'archive') { task.status = 'archived'; if (next.currentTaskId === task.id) next.currentTaskId = null; }
      next.version += 1;
      next.receipts[input.operationId] = signature;
      this.validateWorkspace(next);
      await atomicWrite(project.workspaceFile, next);
      project.workspace = next;
      return this.workspace(project);
    });
    project.queue = job.catch(() => {});
    return job;
  }

  async close() {
    await this.queue;
    await Promise.all([...this.projects.values()].map(async project => { await project.queue; await project.store.close(); }));
    // Covers failures before attach('default') could complete.
    if (!this.projects.has('default')) await this.defaultStore.close();
  }
}

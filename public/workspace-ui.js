import { projectId, workspacePageUrl } from './workspace-context.js';

const textKinds = new Set(['note', 'question', 'hypothesis', 'evidence', 'plan', 'task']);
const node = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children); return el;
};
export function createWorkspaceUI({ api, getDocument, canNavigate, canRefreshScope, onScopeChange, notify }) {
  let state = null, projects = [], showAll = false, changing = false;
  const locked = new URLSearchParams(location.search).get('projectLocked') === '1';
  const full = () => document.body.dataset.uiMode === 'full';
  const current = () => state?.tasks.find(task => task.id === state.currentTaskId && task.status === 'active');
  const objectAllowed = object => full() || (object?.kind === 'molecule' || object?.kind === 'reaction');
  const visibleIds = () => {
    const doc = getDocument(), ids = full() && showAll ? Object.keys(doc?.objects || {}) : current()?.objectIds || [];
    return new Set(ids.filter(id => doc?.objects[id] && objectAllowed(doc.objects[id])));
  };
  const projectSelect = node('select', { id: 'project-select', 'aria-label': '当前项目', disabled: locked });
  const projectNew = node('button', { id: 'project-new', type: 'button', disabled: locked, onClick: () => projectDialog() }, '＋ 项目');
  const projectBar = node('div', { className: 'project-picker' }, projectSelect, projectNew);
  document.querySelector('.top-actions').before(projectBar);
  projectBar.title = locked ? '此面板固定到宿主当前项目' : '每个项目独立保存画板、任务与选择；宿主对话需对应当前项目';
  if (locked) projectBar.append(node('small', {}, '宿主固定项目'));
  projectSelect.addEventListener('change', () => {
    const next = projectSelect.value; projectSelect.value = projectId;
    if (locked || !canNavigate()) return;
    navigate(next);
  });
  function navigate(next) { location.assign(workspacePageUrl('/', next)); }
  const taskSelect = node('select', { id: 'task-select', 'aria-label': '当前任务', onChange: async () => {
    const target = taskSelect.value; taskSelect.value = state?.currentTaskId || '';
    if (!target || !canNavigate()) return;
    try { await change({ action: 'activate', taskId: target }); showAll = false; onScopeChange(); }
    catch (error) { notify(error.message, true); }
  } });
  const taskNew = node('button', { id: 'task-new', type: 'button', onClick: () => taskDialog(false) }, '＋ 新建任务');
  const taskScope = node('button', { id: 'task-scope', type: 'button', hidden: true, onClick: () => taskDialog(true) }, '任务范围');
  const taskStatus = node('span', { id: 'task-status', role: 'status' });
  const recordsContent = node('div', { className: 'workspace-records-content' });
  const recordsSummary = node('summary', {}, '其他记录');
  const records = node('details', { id: 'workspace-records', className: 'workspace-records', hidden: true }, recordsSummary, recordsContent);
  const taskbar = node('div', { className: 'taskbar' }, taskSelect, taskNew, taskScope, taskStatus);
  const toolbar = document.querySelector('.collaboration-bar');
  toolbar.prepend(taskbar);
  const help = toolbar.querySelector('.collaboration-help');
  const context = toolbar.querySelector('.collaboration-context');
  toolbar.append(node('div', { className: 'workspace-disclosures' }, records, help), context);
  help.querySelector('div').append(node('p', {}, locked ? '画板与宿主绑定到同一项目。' : '在宿主对话中使用同一项目。切换画板时，聊天记录会保留。'));
  document.addEventListener('click', event => {
    for (const disclosure of [records, help]) if (!disclosure.contains(event.target)) disclosure.open = false;
  });
  function render() {
    const doc = getDocument();
    const tasks = state?.tasks || [];
    const activeTasks = tasks.filter(task => task.status === 'active');
    const task = current();
    const choices = task ? activeTasks : [{ id: '', title: '选择任务' }, ...activeTasks];
    if (taskSelect.options.length !== choices.length || choices.some((item, index) =>
      taskSelect.options[index].value !== item.id || taskSelect.options[index].textContent !== item.title
    )) {
      taskSelect.replaceChildren(...choices.map(item => node('option', { value: item.id, disabled: !item.id }, item.title)));
    }
    if (taskSelect.value !== (task?.id || '')) taskSelect.value = task?.id || '';
    taskSelect.title = task?.title || '选择任务';
    taskSelect.hidden = !activeTasks.length;
    taskSelect.disabled = changing;
    taskNew.disabled = !state || changing;
    taskScope.hidden = !task;
    taskScope.disabled = changing;
    taskStatus.textContent = full() && showAll ? '正在查看整个项目' : '';
    recordsContent.replaceChildren();
    const visible = visibleIds();
    const outside = Object.values(doc?.objects || {}).filter(o => !visible.has(o.id));
    const structureCount = outside.filter(o => o.kind === 'molecule' || o.kind === 'reaction').length;
    const noteCount = outside.filter(o => textKinds.has(o.kind)).length;
    const archivedTasks = tasks.filter(item => item.status === 'archived');
    records.hidden = !full() && !structureCount && !noteCount && !archivedTasks.length;
    if (records.hidden) records.open = false;
    recordsSummary.textContent = '其他记录';
    if (structureCount || noteCount) recordsContent.append(node('p', { className: 'field-hint' }, [
      structureCount && `${structureCount} 个结构`,
      noteCount && `${noteCount} 条研究记录`
    ].filter(Boolean).join(' · ')));
    if (full()) {
      recordsContent.append(node('button', { id: 'project-show-all', onClick: () => {
        if (!canNavigate()) return; showAll = !showAll; records.open = false; onScopeChange();
      } }, showAll ? '返回当前任务' : '展开项目全部内容'));
    } else if (noteCount) recordsContent.append(node('p', { className: 'field-hint' }, '笔记与研究文字仅在全功能模式展示。'));
    for (const task of archivedTasks) {
      const item = node('button', { className: 'record-task', disabled: changing, onClick: async () => {
        if (!canNavigate()) return;
        try { await change({ action: 'activate', taskId: task.id }); showAll = false; onScopeChange(); records.open = false; }
        catch (error) { notify(error.message, true); }
      } }, `恢复任务 · ${task.title}`);
      recordsContent.append(item);
    }
    if (!task && structureCount) recordsContent.append(node('button', { onClick: () => { records.open = false; taskDialog(false); } }, '从已有结构开始任务'));
  }
  async function change(input, expectedVersion = state?.version) {
    if (changing || !state) throw new Error('任务状态正在更新，请稍候');
    changing = true; render();
    try {
      const result = await api('/api/workspace/tasks', { operationId: `task_${crypto.randomUUID()}`, expectedVersion, ...input });
      state = result.workspace || result; render(); return state;
    } catch (error) {
      if (error.code === 'CONFLICT') {
        const latest = await api('/api/workspace'); state = latest.workspace || latest;
        error.message = '任务范围已被其他窗口修改。本次范围未保存，请关闭并重新选择。';
      }
      throw error;
    } finally { changing = false; render(); }
  }
  function dialog(title) {
    const form = node('form'), error = node('p', { className: 'error-text', role: 'alert' });
    const modal = node('dialog', { className: 'workspace-dialog' }, node('h2', {}, title), form);
    const close = () => { modal.close(); modal.remove(); };
    modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(modal); return { modal, form, error, close };
  }
  function projectDialog() {
    if (locked || !canNavigate()) return;
    const { modal, form, error, close } = dialog('创建独立项目');
    const title = node('input', { id: 'project-title', required: true, maxLength: 120, placeholder: '项目名称' });
    const submit = node('button', { type: 'submit', className: 'primary' }, '创建并打开');
    form.append(node('label', {}, '项目名称', title), node('p', { className: 'field-hint' }, '打开空白工作区。当前项目记录仍保留；宿主聊天不会自动切换项目。'), error, node('div', { className: 'dialog-actions' }, node('button', { type: 'button', onClick: close }, '取消'), submit));
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true;
      try { const result = await api('/api/projects', { title: title.value.trim(), operationId: `project_${crypto.randomUUID()}` }); close(); navigate(result.project.id); }
      catch (failure) { error.textContent = failure.message; submit.disabled = false; }
    });
    modal.showModal(); title.focus();
  }
  function taskDialog(edit) {
    if (!state || !canNavigate()) return;
    const task = edit ? current() : null;
    if (edit && !task) return;
    const version = state.version;
    const { modal, form, error, close } = dialog(edit ? '当前任务范围' : '开始一个任务');
    const title = node('input', { id: 'task-title', required: !!task, maxLength: 120, placeholder: task ? '任务名称' : '可选，留空使用所选结构名称', value: task?.title || '' });
    const list = node('div', { className: 'task-scope-list' });
    for (const object of Object.values(getDocument()?.objects || {}).filter(objectAllowed)) {
      list.append(node('label', {}, node('input', { type: 'checkbox', value: object.id, checked: task?.objectIds.includes(object.id) || false }), `${object.title || '未命名结构'}${object.kind === 'molecule' ? '' : ` · ${object.kind}`}`));
    }
    if (!list.children.length) list.append(node('p', { className: 'field-hint' }, '可先创建空任务，再绘制或导入分子。'));
    const submit = node('button', { type: 'submit', className: 'primary' }, edit ? '保存范围' : '开始任务');
    const actions = node('div', { className: 'dialog-actions' }, node('button', { type: 'button', onClick: close }, '取消'), submit);
    if (task) actions.prepend(node('button', { type: 'button', onClick: async event => {
      event.currentTarget.disabled = true;
      try { await change({ action: 'archive', taskId: task.id }, version); close(); showAll = false; onScopeChange(); }
      catch (failure) { error.textContent = failure.message; event.currentTarget.disabled = false; }
    } }, '归档任务'));
    form.append(node('label', {}, task ? '任务名称' : '任务名称（可选）', title), node('p', { className: 'field-hint' }, '勾选本次要一起查看的结构。未选内容保留在项目中。'), list, error, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true;
      // Hidden text records in a simple-mode edit remain in the task; hiding is not deletion.
      const hidden = (task?.objectIds || []).filter(id => getDocument()?.objects[id] && ![...list.querySelectorAll('input')].some(input => input.value === id));
      const objectIds = [...new Set([...hidden, ...[...list.querySelectorAll('input:checked')].map(input => input.value)])];
      const taskTitle = title.value.trim() || getDocument()?.objects[objectIds[0]]?.title || '结构任务';
      try { await change({ action: task ? 'update' : 'create', ...(task ? { taskId: task.id } : {}), title: taskTitle, objectIds }, version); close(); showAll = false; onScopeChange(); }
      catch (failure) { error.textContent = failure.message; submit.disabled = false; }
    });
    modal.showModal(); title.focus();
  }
  return {
    visibleIds, render,
    showProjectCards() { showAll = true; onScopeChange(false); },
    async refresh() {
      const [result, catalog] = await Promise.all([api('/api/workspace'), api('/api/projects')]);
      const next = result.workspace || result;
      // An older polling response must not overwrite a successful scope write.
      if (!state || (next.version > state.version && canRefreshScope())) { state = next; render(); onScopeChange(false); }
      projects = catalog.projects;
      projectSelect.replaceChildren(...projects.map(project => node('option', { value: project.id }, project.title)));
      projectSelect.value = projectId; render();
    },
    async includeSaved(objectId) {
      if (!state) { notify('结构已保存；任务尚未读取，请读取后选择任务范围。', true); return; }
      const task = current(); if (task?.objectIds.includes(objectId)) return;
      // Capture the real version; a concurrent writer is surfaced, never silently retried.
      const version = state.version;
      try { await change(task ? { action: 'update', taskId: task.id, objectIds: [...task.objectIds, objectId] } : { action: 'create', title: getDocument()?.objects[objectId]?.title || '结构任务', objectIds: [objectId] }, version); onScopeChange(false); }
      catch (error) { notify(`结构已保存，但未加入当前任务：${error.message}`, true); }
    }
  };
}

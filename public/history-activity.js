const pageSize = 20;

// Only read the visible page. A late receipt may populate its old DOM nodes but
// cannot replace a newer revision or a newly reopened history dialog.
export function showHistoryEntries(panel, { entries, api, el, renderTarget }) {
  const cache = panel.activityCache ??= new Map();
  const list = el('div', { class: 'history-list' });
  panel.append(list);
  function appendPage(start) {
    const page = entries.slice(start, start + pageSize);
    if (!page.length) return;
    const slots = new Map();
    for (const entry of page) {
      const actor = entry.actor === 'agent' ? 'Agent' : '研究者';
      const slot = el('div', { class: 'history-activity' });
      slots.set(entry.revision, slot);
      const metadata = Object.fromEntries(Object.entries(entry).filter(([key]) => !['before', 'after', 'inverse', 'snapshot'].includes(key)));
      list.append(el('article', { class: 'history-entry', 'data-revision': entry.revision },
        el('strong', {}, `${actor} · r${entry.revision}`), el('p', {}, entry.intent || entry.summary || entry.type), slot,
        el('details', {}, el('summary', {}, '操作详情'), el('pre', {}, JSON.stringify(metadata, null, 2)))));
    }
    const first = page.at(-1).revision;
    const render = () => {
      for (const [revision, slot] of slots) {
        const receipt = cache.get(revision);
        if (receipt) slot.replaceChildren(...receipt.rows.map(renderTarget), ...receipt.notes.map(note => el('p', {}, note)));
      }
    };
    async function load() {
      render();
      if (page.every(entry => cache.has(entry.revision))) return;
      try {
        const { events } = await api(`/api/changes?detail=activity&sinceRevision=${first - 1}&limit=${page.length}`);
        for (const event of events) cache.set(event.revision, event);
        render();
      } catch (error) {
        const retry = el('button', { type: 'button', title: error.message, onClick: () => { retry.remove(); load(); } }, '改动对象读取失败，重试');
        slots.get(page[0].revision).append(retry);
      }
    }
    load();
    if (start + pageSize < entries.length) {
      if (panel.shownEntries > start + pageSize) appendPage(start + pageSize);
      else {
        const more = el('button', { type: 'button', onClick: () => {
          more.remove(); panel.shownEntries = start + pageSize * 2; appendPage(start + pageSize);
        } }, '查看更早的修改');
        list.append(more);
      }
    }
  }
  appendPage(0);
}

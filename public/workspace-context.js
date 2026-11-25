// A page owns one immutable project. Never infer it from another window.
const pageQuery = new URLSearchParams(location.search);
export const projectId = pageQuery.has('project') ? pageQuery.get('project') : 'default';
export const projectLocked = pageQuery.get('projectLocked') === '1';
export function scopeUrl(path) {
  if (pageQuery.getAll('project').length > 1) throw new Error('一个工作区只能绑定一个项目');
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) throw new Error('工作区请求必须使用当前本地服务');
  if (url.searchParams.has('project') && url.searchParams.get('project') !== projectId) throw new Error('请求项目与当前工作区不一致');
  url.searchParams.set('project', projectId);
  return url.pathname + url.search + url.hash;
}
export function scopedFetch(path, options) { return globalThis.fetch(scopeUrl(path), options); }
export function workspacePageUrl(path, nextProject = projectId) {
  const url = new URL(path, location.href);
  url.searchParams.set('project', nextProject);
  if (new URLSearchParams(location.search).get('embed') === '1') url.searchParams.set('embed', '1');
  if (new URLSearchParams(location.search).get('projectLocked') === '1') url.searchParams.set('projectLocked', '1');
  return url.pathname + url.search + url.hash;
}

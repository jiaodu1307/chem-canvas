const reserved = new Set(['__proto__', 'prototype', 'constructor']);
export function validateProjectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value) || reserved.has(value)) {
    throw Object.assign(new Error('projectId 必须为有效的项目标识。'), {code: 'VALIDATION'});
  }
  return value;
}

export function projectEndpoint(baseUrl, configuredProjectId) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.hash
    || [...url.searchParams.keys()].some(key => key !== 'project') || url.searchParams.getAll('project').length > 1) {
    throw new Error('MCP must connect to a loopback HTTP origin with an optional project query.');
  }
  const urlProject = url.searchParams.has('project') ? validateProjectId(url.searchParams.get('project')) : undefined;
  if (configuredProjectId !== undefined) validateProjectId(configuredProjectId);
  if (urlProject && configuredProjectId && urlProject !== configuredProjectId) {
    throw Object.assign(new Error('配置的项目与 URL 项目不一致。'), {code: 'PROJECT_MISMATCH'});
  }
  return {url, projectId: configuredProjectId ?? urlProject};
}

export function selectProject({boundProjectId, requestedProjectId, projects}) {
  if (requestedProjectId !== undefined) validateProjectId(requestedProjectId);
  if (boundProjectId && requestedProjectId && boundProjectId !== requestedProjectId) {
    throw Object.assign(new Error('此 MCP 会话已绑定其他项目；请使用对应项目的会话。'), {code: 'PROJECT_MISMATCH'});
  }
  const projectId = boundProjectId ?? requestedProjectId;
  if (projects && projectId && !projects.some(project => project.id === projectId)) {
    throw Object.assign(new Error('项目不存在；未回退到其他项目。'), {code: 'NOT_FOUND'});
  }
  if (!projectId && projects?.length > 1) {
    throw Object.assign(new Error('存在多个项目。请根据用户当前工作区选择明确的 projectId，再读取和操作；不要猜测最近活跃项目。'),
      {code: 'PROJECT_REQUIRED', projects});
  }
  return projectId ?? projects?.[0]?.id;
}

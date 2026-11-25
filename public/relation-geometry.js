// Same deterministic endpoint selection for the interactive canvas and read-only overview.
const center = v => ({ x: v.x + v.width / 2, y: v.y + v.height / 2 });
export function relationGeometry(document, relation) {
  const views = Object.values(document.views);
  const candidates = (objectId, anchor) => anchor
    ? views.filter(v => v.id === anchor && v.objectId === objectId)
    : views.filter(v => v.objectId === objectId).sort((a, b) => a.id.localeCompare(b.id));
  const sources = candidates(relation.from, relation.fromViewId), targets = candidates(relation.to, relation.toViewId);
  let chosen = null, distance = Infinity;
  for (const from of sources) for (const to of targets) {
    if (from.id === to.id) continue;
    const a = center(from), b = center(to), d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 0 && d < distance) { chosen = { from, to, a, b }; distance = d; }
  }
  if (!chosen) return null;
  const { from, to, a, b } = chosen, dx = b.x - a.x, dy = b.y - a.y;
  const edge = (v, c, sign) => {
    const t = Math.min(dx ? v.width / 2 / Math.abs(dx) : Infinity, dy ? v.height / 2 / Math.abs(dy) : Infinity);
    return { x: c.x + sign * dx * t, y: c.y + sign * dy * t };
  };
  const start = edge(from, a, 1), end = edge(to, b, -1);
  return { fromViewId: from.id, toViewId: to.id, start, end,
    anchoring: relation.fromViewId && relation.toViewId ? 'explicit' : 'nearest-view-fallback',
    path: `M${start.x},${start.y} L${end.x},${end.y}` };
}

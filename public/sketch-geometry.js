// Geometry only: all output becomes ordinary typed graph edits at commit time.
export const DEFAULT_LENGTH = 1.5;
const TAU = Math.PI * 2;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const polar = (a, angle, length) => ({ x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length });
export function bondLength(graph) {
  const lengths = graph.bonds.map(b => {
    const a = graph.atoms.find(a => a.id === b.from), c = graph.atoms.find(a => a.id === b.to);
    return a && c ? distance(a, c) : 0;
  }).filter(n => Number.isFinite(n) && n > .05).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  return lengths.length ? (lengths[middle] + lengths[Math.floor((lengths.length - 1) / 2)]) / 2 : DEFAULT_LENGTH;
}
export function snappedEndpoint(start, cursor, length, free = false) {
  if (free) return { x: cursor.x, y: cursor.y };
  const angle = Math.round(Math.atan2(cursor.y - start.y, cursor.x - start.x) / (Math.PI / 6)) * Math.PI / 6;
  return polar(start, angle, length);
}
export function nearestAtom(graph, point, radius, exclude) {
  return graph.atoms.filter(a => a.id !== exclude).map(a => ({ a, d: distance(a, point) }))
    .filter(v => v.d < radius).sort((a, b) => a.d - b.d)[0]?.a;
}
function neighbours(graph, atom) {
  return graph.bonds.filter(b => b.from === atom.id || b.to === atom.id)
    .map(b => graph.atoms.find(a => a.id === (b.from === atom.id ? b.to : b.from))).filter(Boolean);
}
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  const t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared)) : 0;
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
function crosses(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10;
}
function ringCollision(graph, vertices, length) {
  const existingEdges = graph.bonds.map(b => [graph.atoms.find(a => a.id === b.from), graph.atoms.find(a => a.id === b.to)])
    .filter(([a, b]) => a && b);
  for (const vertex of vertices.filter(v => !v.id)) {
    if (nearestAtom(graph, vertex, length * .35) || existingEdges.some(([a, b]) => segmentDistance(vertex, a, b) < length * .25)) return true;
  }
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    // The shared bond is retained, not newly drawn.
    if (a.id && b.id && graph.bonds.some(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id))) continue;
    if (graph.atoms.some(p => p.id !== a.id && p.id !== b.id && segmentDistance(p, a, b) < length * .25)) return true;
    if (existingEdges.some(([c, d]) => crosses(a, b, c, d))) return true;
  }
  return false;
}
function crowding(graph, points, excluded = []) {
  let score = 0;
  const length = bondLength(graph);
  for (const p of points) for (const a of graph.atoms) {
    if (excluded.includes(a.id)) continue;
    const d = distance(p, a) / length;
    score += d < .4 ? 1000 : 1 / Math.max(.01, d ** 4);
  }
  return score;
}
export function extendEndpoint(graph, atom, length = bondLength(graph), order = 1) {
  const ns = neighbours(graph, atom);
  let angles;
  if (ns.length === 1) {
    const forward = Math.atan2(atom.y - ns[0].y, atom.x - ns[0].x);
    const incoming = graph.bonds.find(b => (b.from === atom.id && b.to === ns[0].id) || (b.to === atom.id && b.from === ns[0].id));
    // An sp center continues in a straight line, including when the new bond
    // (optional fourth argument) is triple and the existing bond is single.
    angles = incoming?.order === 3 || order === 3 ? [forward] : [forward + Math.PI / 3, forward - Math.PI / 3];
  } else angles = Array.from({ length: 12 }, (_, n) => Math.PI / 6 + n * Math.PI / 6);
  return angles.map(angle => ({ point: polar(atom, angle, length), angle }))
    .map(c => ({ ...c, score: crowding(graph, [c.point], [atom.id]) - .12 * Math.cos(c.angle) - .001 * Math.sin(c.angle) }))
    .sort((a, b) => a.score - b.score)[0].point;
}

// Shared vertices carry IDs; the remaining vertices are created only on commit.
export function planRing(graph, { size = 6, aromatic = false, point, anchorAtomId, anchorBondId, sidePoint, length = bondLength(graph) }) {
  const bond = anchorBondId === undefined ? undefined : graph.bonds.find(b => b.id === anchorBondId);
  const anchor = anchorAtomId === undefined ? undefined : graph.atoms.find(a => a.id === anchorAtomId);
  let candidates;
  if (bond) {
    const a = graph.atoms.find(a => a.id === bond.from), b = graph.atoms.find(a => a.id === bond.to);
    const edgeLength = distance(a, b), angle = Math.atan2(b.y - a.y, b.x - a.x);
    candidates = [1, -1].map(sign => {
      const vertices = [{ ...a }, { ...b }];
      for (let i = 1; i < size - 1; i++) vertices.push(polar(vertices.at(-1), angle + sign * TAU * i / size, edgeLength));
      return { vertices, sign };
    });
    if (sidePoint) {
      const cross = (b.x - a.x) * (sidePoint.y - a.y) - (b.y - a.y) * (sidePoint.x - a.x);
      if (Math.abs(cross) > edgeLength * .12) candidates = candidates.filter(c => c.sign === Math.sign(cross));
    }
  } else {
    const radius = length / (2 * Math.sin(Math.PI / size));
    const direction = anchor ? extendEndpoint(graph, anchor, length) : null;
    const angle = anchor ? Math.atan2(direction.y - anchor.y, direction.x - anchor.x) : 0;
    const center = anchor ? polar(anchor, angle, radius) : point;
    const vertices = Array.from({ length: size }, (_, i) => polar(center, angle + Math.PI + i * TAU / size, radius));
    if (anchor) vertices[0] = { ...anchor };
    candidates = [{ vertices }];
  }
  // An atom-only crowding score can prefer a side crossed by a long bond.
  // Prefer any geometrically valid candidate before comparing soft crowding.
  candidates.forEach(c => { c.collision = ringCollision(graph, c.vertices, bond ? distance(c.vertices[0], c.vertices[1]) : length); });
  candidates.sort((a, b) => Number(a.collision) - Number(b.collision) || crowding(graph, a.vertices.filter(v => !v.id)) - crowding(graph, b.vertices.filter(v => !v.id)));
  const vertices = candidates[0].vertices;
  const collision = candidates[0].collision;
  const valence = id => graph.bonds.filter(b => b.from === id || b.to === id).reduce((n, b) => n + b.order, 0);
  const doubleAtEnds = bond && bond.order === 1 && valence(bond.from) <= 2 && valence(bond.to) <= 2;
  const edges = Array.from({ length: size }, (_, i) => ({
    from: i, to: (i + 1) % size,
    order: bond && i === 0 ? bond.order : aromatic ? (bond ? ((i % 2 === 1) === !!doubleAtEnds ? 2 : 1) : (i % 2 === 0 ? 2 : 1)) : 1,
    ...(bond && i === 0 ? { id: bond.id } : {})
  }));
  return { vertices, edges, collision };
}
export function ringEdits(plan, uid) {
  if (plan.collision) throw new Error('环与已有原子重叠，请拖到键的另一侧或换一个连接位置');
  const edits = [], ids = plan.vertices.map(v => {
    if (v.id) return v.id;
    const id = uid('atom'); edits.push({ type: 'addAtom', atom: { id, atomicNumber: 6, x: v.x, y: v.y, formalCharge: 0, isotope: 0 } }); return id;
  });
  for (const e of plan.edges) if (!e.id) edits.push({ type: 'addBond', bond: { id: uid('bond'), from: ids[e.from], to: ids[e.to], order: e.order } });
  return edits;
}

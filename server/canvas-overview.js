import { Resvg } from '@resvg/resvg-js';
import { createHash } from 'node:crypto';
import { renderMolecule } from '../src/chemistry/index.js';
import { relationGeometry } from '../public/relation-geometry.js';
import { failure } from './store.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
function lines(value, width, limit) {
  const capacity = Math.max(2, Math.floor(width / 9)), result = []; let line = '', size = 0, truncated = false;
  for (const c of String(value ?? '')) {
    const weight = c.charCodeAt(0) > 255 ? 1.8 : 1;
    if (c === '\n' || size + weight > capacity) { result.push(line); line = ''; size = 0; if (result.length >= limit) { truncated = true; break; } }
    if (c !== '\n') { line += c; size += weight; }
  }
  if (line && result.length < limit) result.push(line);
  if (truncated && result.length) result[result.length - 1] += '…';
  return { rows: result, truncated };
}
const textBlock = (rows, x, y, size = 14) => rows.map((text, i) => `<text x="${x}" y="${y + i * (size + 6)}" font-size="${size}">${escape(text)}</text>`).join('');

export async function canvasOverview(document, options = {}) {
  const all = Object.values(document.views);
  if (options.viewIds !== undefined && (!Array.isArray(options.viewIds) || !options.viewIds.length || options.viewIds.length > 200 || options.viewIds.some(id => typeof id !== 'string' || !Object.hasOwn(document.views, id)))) throw failure('VALIDATION', 'viewIds 必须包含 1–200 个当前展示 ID。');
  const views = options.viewIds ? all.filter(v => options.viewIds.includes(v.id)) : all;
  if (views.length > 200) throw failure('VALIDATION', '整图最多渲染 200 个展示，请提供 viewIds 分组检查。');
  const maxDimension = options.maxDimension ?? 1600;
  if (!Number.isInteger(maxDimension) || maxDimension < 320 || maxDimension > 2400) throw failure('VALIDATION', 'maxDimension 必须在 320–2400 之间。');
  let bounds = views.length ? {
    x: Math.min(...views.map(v => v.x)) - 30, y: Math.min(...views.map(v => v.y)) - 30,
    width: Math.max(...views.map(v => v.x + v.width)) - Math.min(...views.map(v => v.x)) + 60,
    height: Math.max(...views.map(v => v.y + v.height)) - Math.min(...views.map(v => v.y)) + 60,
  } : { x: 0, y: 0, width: 640, height: 320 };
  if (options.region !== undefined) {
    const r = options.region;
    if (!r || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) <= 1e7) || r.width < 1 || r.height < 1) throw failure('VALIDATION', 'region 需要有限的画布坐标和正宽高。');
    bounds = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width > 1e7 || bounds.height > 1e7) throw failure('VALIDATION', '画布范围过大，请指定局部 region。');
  const scale = Math.min(1, maxDimension / Math.max(bounds.width, bounds.height));
  const width = Math.max(1, Math.ceil(bounds.width * scale)), height = Math.max(1, Math.ceil(bounds.height * scale));
  const selectedIds = new Set(views.map(v => v.id)), edges = [], warnings = [];
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="white"/><defs><marker id="route-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#67756c"/></marker></defs><g font-family="Arial, Microsoft YaHei, sans-serif" fill="#26372d">`];
  for (const relation of Object.values(document.relations)) {
    const g = relationGeometry(document, relation);
    if (!g) { warnings.push({ code: 'RELATION_WITHOUT_VISIBLE_ENDPOINTS', relationId: relation.id }); continue; }
    if (!selectedIds.has(g.fromViewId) || !selectedIds.has(g.toViewId)) continue;
    edges.push({ relationId: relation.id, kind: relation.kind, ...g });
    parts.push(`<path d="${g.path}" fill="none" stroke="#67756c" stroke-width="2" marker-end="url(#route-arrow)"/>`);
    parts.push(textBlock([relation.kind], (g.start.x + g.end.x) / 2 + 4, (g.start.y + g.end.y) / 2 - 8, 11));
  }
  const renderings = new Map();
  for (const v of views) {
    const o = document.objects[v.objectId];
    if (v.width < 90 || v.height < 100) warnings.push({ code: 'CARD_TOO_SMALL', viewId: v.id });
    const title = lines(o.title, Math.max(20, v.width - 24), 2), titleHeight = title.rows.length * 24;
    const top = v.y + 16 + titleHeight, availableHeight = Math.max(1, v.height - titleHeight - 34);
    parts.push(`<svg x="${v.x}" y="${v.y}" width="${v.width}" height="${v.height}" viewBox="${v.x} ${v.y} ${v.width} ${v.height}" overflow="hidden"><rect x="${v.x}" y="${v.y}" width="${v.width}" height="${v.height}" rx="8" fill="white" stroke="#c5cfc8"/>`);
    parts.push(textBlock(title.rows, v.x + 12, v.y + 24, 17));
    if (title.truncated) warnings.push({ code: 'TRUNCATED_TITLE', viewId: v.id });
    if (o.kind === 'molecule') {
      if (!renderings.has(o.id)) renderings.set(o.id, (await renderMolecule(o.data)).svg);
      const source = Buffer.from(renderings.get(o.id)).toString('base64');
      parts.push(`<image x="${v.x + 10}" y="${top}" width="${Math.max(1, v.width - 20)}" height="${availableHeight}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/svg+xml;base64,${source}"/>`);
    } else {
      const content = lines(o.data.text ?? '', Math.max(20, v.width - 24), Math.max(1, Math.floor(availableHeight / 20)));
      parts.push(textBlock(content.rows, v.x + 12, top + 14));
      if (content.truncated) warnings.push({ code: 'TRUNCATED_TEXT', viewId: v.id });
    }
    parts.push('</svg>');
  }
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
    const a = views[i], b = views[j];
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) warnings.push({ code: 'OVERLAPPING_CARDS', viewIds: [a.id, b.id] });
  }
  parts.push('</g></svg>'); const svg = parts.join('');
  return { documentId: document.id, revision: document.revision, state: 'saved', representation: 'canvas-overview',
    description: 'Read-only overview using saved card geometry, shared relation anchors and fresh molecular depictions; not a browser screenshot. Inspect crops for small structures.',
    bounds, width, height, views: views.map(v => ({ ...v, title: document.objects[v.objectId].title, objectVersion: document.objects[v.objectId].version })), relations: edges, warnings, svg };
}

export function canvasOverviewImage(result,region) {
  const dimension=result.width>=result.height?'width':'height';
  const maximum=result[dimension];
  const options={...(maximum>4096?{fitTo:{mode:dimension,value:4096}}:{}),background:'white',font:{loadSystemFonts:true,defaultFontFamily:'Arial'}};
  if(region){
    // Crop the same rendered surface as the full preview, including fonts and viewBox margins.
    const scale=Math.min(1,4096/maximum);
    const width=Math.max(1,Math.round(result.width*scale)),height=Math.max(1,Math.round(result.height*scale));
    const left=Math.min(width-1,Math.floor(region.x*width)),top=Math.min(height-1,Math.floor(region.y*height));
    const right=Math.min(width,Math.max(left+1,Math.ceil((region.x+region.width)*width)));
    const bottom=Math.min(height,Math.max(top+1,Math.ceil((region.y+region.height)*height)));
    options.crop={left,top,right,bottom};
  }
  const rendered = new Resvg(result.svg,options).render();
  const png = rendered.asPng();
  return { content: { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    metadata: { documentId: result.documentId, revision: result.revision, state: result.state??'saved', representation: result.representation,
      bounds: result.bounds, width: rendered.width, height: rendered.height, mimeType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), renderer: 'resvg' } };
}

export function figureRegionImage(figure, note) {
  return canvasOverviewImage({...figure,bounds:note.region,state:'saved',representation:'figure-review-region'},note.region);
}

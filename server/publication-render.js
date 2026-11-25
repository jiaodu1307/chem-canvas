import { _editingToolkit, renderMolecule } from '../src/chemistry/index.js';
import PDFDocument from 'pdfkit';
import { headerTemplateSvg } from './publication-header-template.js';
import { resolveRingScope } from './publication-ring-scope.js';
import { drawMolecule } from '../src/chemistry/drawing.js';
import { chemicalSignature } from '../src/chemistry/layout.js';
import { failure } from './store.js';
import { resolveScaffoldGroup } from './publication-scaffold.js';

// SVG user units are printer's points throughout. Dimensions on the root are physical.
const MM_PER_PT = 25.4 / 72;
const PROFILES = {
  orglett: { widths: [84.6, 177.8], maxHeight: 660 * MM_PER_PT },
  obc: { widths: [83, 171], maxHeight: 233 },
};
const FONT = 'Arial, Helvetica, sans-serif';
const BASE_SCALE = 0.9;
const MARGIN = 6;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => Number(value.toFixed(3));
const bad = message => { throw failure('VALIDATION', message); };
const rule = (x1, y, x2) => `<line x1="${fmt(x1)}" y1="${fmt(y)}" x2="${fmt(x2)}" y2="${fmt(y)}" stroke="currentColor" stroke-width="0.55"/>`;
const textRun = (line, x, y, size, bold = false, anchor = 'start') =>
  `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${size}" text-anchor="${anchor}"${bold ? ' font-weight="bold"' : ''}>${esc(line)}</text>`;

function textWidth(value, size) {
  // Conservative Arial advances for Latin and full-width glyphs. Long tokens may wrap.
  let units = 0;
  for (const c of value) {
    if (/[\u0300-\u036f\uFE00-\uFE0F]/u.test(c)) continue;
    if (/[^\u0000-\u02ff]/u.test(c)) units += 1.07;
    else if (/[mwMW@%&]/.test(c)) units += 1;
    else if (/[ilI1.,:;|!'\s]/.test(c)) units += 0.4;
    else units += /[A-Z]/.test(c) ? 0.82 : 0.68;
  }
  return units * size;
}

// Use the PDF export font's real advances for dense printed scaffold lists.
// Non-Latin symbols still reserve a full em even when a PDF font lacks them.
let scopeFontMetrics;
function scaffoldTextWidth(value,size) {
  if (!scopeFontMetrics) {
    scopeFontMetrics=new PDFDocument({autoFirstPage:false});
    scopeFontMetrics.font('Helvetica');
  }
  const latin=value.replace(/[₀-₉]/g,c=>String(c.codePointAt(0)-0x2080)).replace(/[^\x20-\x7e]/g,'');
  const other=[...value].filter(c=>!/[\x20-\x7e₀-₉]/.test(c)).join('');
  return scopeFontMetrics.fontSize(size).widthOfString(latin)*1.05+textWidth(other,size);
}

function wrap(value, width, size,measure=textWidth) {
  const lines = [];
  for (const paragraph of String(value).split(/\r\n?|\n/)) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line && measure(line + ' ' + word, size) <= width) { line += ' ' + word; continue; }
      if (line) lines.push(line);
      line = '';
      for (const c of word) {
        if (line && measure(line + c, size) > width) { lines.push(line); line = ''; }
        line += c;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawLines(parts, lines, x, y, size, bold = false, anchor = 'start') {
  for (const line of lines) {
    parts.push(textRun(line, x, y + size, size, bold, anchor));
    y += size * 1.35;
  }
  return y;
}

function svgDocument(parts, width, height, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:rdkit="http://www.rdkit.org/xml" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(width * MM_PER_PT)}mm" height="${fmt(height * MM_PER_PT)}mm" viewBox="0 0 ${fmt(width)} ${fmt(height)}" role="img"><title>${esc(title)}</title><rect width="100%" height="100%" fill="white"/><g font-family="${FONT}" fill="black">${parts.join('\n')}</g></svg>`;
}

function moleculeDrawing(svg, id) {
  const view = svg.match(/viewBox=['"]([^'"]+)['"]/);
  const body = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/);
  const [x, y, w, h] = (view?.[1] || '').trim().split(/\s+/).map(Number);
  if (!body || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) bad(`Invalid molecular depiction for ${id}.`);
  return { id, x, y, w, h, body: body[1] };
}

function drawMol(mol, cx, cy, scale, attribute = 'data-compound-id') {
  const left = cx - (mol.x + mol.w / 2) * scale;
  const top = cy - (mol.y + mol.h / 2) * scale;
  return `<g ${attribute}="${esc(mol.id)}" transform="translate(${fmt(left)} ${fmt(top)}) scale(${fmt(scale)})">${mol.body}</g>`;
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const name = row.group || '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  return groups;
}

function noteKey(index) {
  let key = '';
  do {
    key = String.fromCharCode(97 + index % 26) + key;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return key;
}

function yieldText(result, hideMethod = false) {
  if (result?.value == null || String(result.value).trim() === '') return '—';
  const value = String(result.value).trim();
  const unit = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? '%' : '';
  return value + unit + (result.footnoteMarker || '') + (result.method && !hideMethod ? ' (' + result.method + ')' : '');
}

function additionalYieldLines(row, hideMethod = false) {
  return (row.additionalYields || []).map(result => result.context + ': ' + yieldText(result, hideMethod));
}

function tableData(document, spec, rows) {
  const notes = new Map();
  for (const row of rows) if (row.note && !notes.has(row.note)) notes.set(row.note, noteKey(notes.size));
  const ref = row => row.note ? ' [' + notes.get(row.note) + ']' : '';
  const label = row => row.label || document.objects[row.compoundId]?.data?.label || document.objects[row.compoundId]?.title || row.compoundId || '';
  const columns = [['Entry', row => row.id + ref(row)]];
  if (rows.some(row => row.compoundId || row.label)) columns.push(['Compound', label]);
  if (rows.some(row => row.group)) columns.push(['Group', row => row.group]);
  const conditions = new Set(spec.conditionColumns || []);
  for (const row of rows) for (const name of Object.keys(row.conditions || {})) conditions.add(name);
  if (conditions.size > 36) bad('A publication can display at most 36 distinct condition columns. Consolidate or split the table.');
  for (const name of conditions) columns.push([name, row => row.conditions?.[name]]);
  columns.push(['Yield', row => yieldText(row.yield)]);
  if (rows.some(row => row.additionalYields?.length)) {
    columns.push(['Additional yields', row => additionalYieldLines(row).join('\n') || '—']);
  }
  if (rows.some(row => row.selectivity)) columns.push(['Selectivity', row => row.selectivity]);
  if (rows.some(row => row.scale)) columns.push(['Scale', row => row.scale]);
  const methodInCaption = spec.kind==='scope' && spec.scopeYieldMethodInCaption;
  let scopeMethod;
  if (methodInCaption) {
    const methods=new Set(rows.flatMap(row=>[row.yield,...(row.additionalYields || [])]).filter(Boolean).map(result=>result.method));
    if (methods.size!==1 || methods.has(undefined)) bad('A shared yield-method caption requires one specified method across all measurements.');
    [scopeMethod]=methods;
  }
  return {
    scopeMethod,
    scopeStyle: spec.kind==='scope' ? spec.scopeStyle || {} : {},
    tableHeaders: columns.map(([name]) => name),
    tableRows: rows.map(row => columns.map(([, read]) => String(read(row) ?? '—'))),
    footnotes: [...notes].map(([note, key]) => `[${key}] ${note}`), ref, label,
  };
}

// Align depiction copies to an actual common substructure. The saved MOL and atom IDs
// remain authoritative. Ambiguous/failed matches leave the entire group as authored.
async function alignGroup(document, ids, drawings, spec) {
  // Shared-core alignment can flip a metal projection and regenerate its CTAB
  // wedges. Keep the source orientations for these groups.
  if(ids.some(id=>document.objects[id].data.coordinationStereo)) return null;
  const rdkit = await _editingToolkit();
  const handles = [];
  const own = handle => { if (handle) handles.push(handle); return handle; };
  try {
    const list = own(new rdkit.MolList());
    const readOptions = JSON.stringify({ removeHs: false, sanitize: true });
    const molecules = ids.map(id => own(rdkit.get_mol(document.objects[id].data.molblock, readOptions)));
    for (const mol of molecules) list.append(mol);
    const mcs = JSON.parse(rdkit.get_mcs_as_json(list, JSON.stringify({Timeout: 1, RingMatchesRingOnly: true, CompleteRingsOnly: true})));
    if (mcs.canceled || mcs.numAtoms < 3 || mcs.numBonds < 2) return null;
    const core = own(rdkit.get_qmol(mcs.smarts));
    if (!core) return null;
    const matches = molecules.map(mol => JSON.parse(mol.get_substruct_matches(core, JSON.stringify({maxMatches: 2, uniquify: true}))));
    if (matches.some(result => !Array.isArray(result) || result.length !== 1)) return null;
    const coords = mol => JSON.parse(mol.get_json()).molecules[0].conformers[0].coords;
    const template = molecules[0], referenceCoords = coords(template);
    const anchor = matches[0][0].atoms.map(idx => referenceCoords[idx]);
    const aligned = new Map([[ids[0], drawings.get(ids[0])]]);
    for (let i = 1; i < ids.length; i++) {
      const mol = molecules[i], signature = chemicalSignature(mol);
      const match = JSON.parse(mol.generate_aligned_coords(template, JSON.stringify({referenceSmarts: mcs.smarts, acceptFailure: false, useCoordGen: false})));
      if (match.atoms?.length !== anchor.length || chemicalSignature(mol) !== signature) return null;
      const actual = coords(mol);
      if (!match.atoms.every(idx => anchor.some(([x, y]) => Math.hypot(x - actual[idx][0], y - actual[idx][1]) < 0.02))) return null;
      const roundtrip = own(rdkit.get_mol(mol.get_v3Kmolblock(), readOptions));
      if (!roundtrip || roundtrip.get_smiles() !== document.objects[ids[i]].data.smiles) return null;
      aligned.set(ids[i], moleculeDrawing(drawMolecule(mol, rdkit.version(),'acs1996',undefined,0,abbreviationsFor(spec,ids[i]),false,rdkit).svg, ids[i]));
    }
    return aligned;
  } catch {
    return null;
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
}

// Explicit publication layout keeps the reaction components, text and catalyst drawings
// as independent semantic objects. Old specs use the original automatic layout below.
function drawLabeledReaction(reaction, drawings, width, scale) {
  const inner = width - 2 * MARGIN, gap = 6, rowGap = 6;
  const parts = [];
  function card(id, role) {
    const mol = drawings.get(id);
    const customLabel = Object.hasOwn(reaction.labels ?? {}, id) ? reaction.labels[id] : '';
    const label = customLabel || (role === 'catalyst' ? mol.title : '');
    const lines = label ? wrap(label, Math.min(inner, 106), 8) : [];
    const repeat = role === 'catalyst' ? reaction.catalystRepeats?.[id] : undefined;
    const pad = repeat ? 18 : 0;
    const molScale = Math.min(scale, (inner - pad) / mol.w);
    return { mol, role, lines, repeat, scale:molScale, height:mol.h * molScale,
      width:Math.max(mol.w * molScale + pad, ...lines.map(line=>textWidth(line,8))) };
  }
  const reactants = reaction.reactantIds.map(id=>card(id,'reactant'));
  const products = reaction.productIds.map(id=>card(id,'product'));
  const catalysts = (reaction.catalystIds ?? []).map(id=>card(id,'catalyst'));
  const groupWidth = cards => cards.reduce((sum,c)=>sum+c.width,0) + Math.max(0,cards.length-1)*14;
  const height = cards => Math.max(0,...cards.map(c=>c.height));
  const labelHeight = cards => Math.max(0,...cards.map(c=>c.lines.length ? c.lines.length*10.8+4 : 0));
  function drawGroup(cards, x, cy, labelTop) {
    for (const [i,c] of cards.entries()) {
      if (i) {
        if (c.role !== 'catalyst') parts.push(textRun('+',x+7,cy+3,10,false,'middle'));
        x += 14;
      }
      const cx = x+c.width/2;
      parts.push('<g data-reaction-role="'+c.role+'">',drawMol(c.mol,cx,cy,c.scale));
      if (c.repeat) {
        const half = c.mol.w*c.scale/2 + 2, top = cy-c.height/2, bottom = cy+c.height/2;
        const left = cx-half, right = cx+half;
        parts.push('<path data-catalyst-repeat="'+c.repeat+'" d="M '+fmt(left+2)+' '+fmt(top)+' H '+fmt(left)+' V '+fmt(bottom)+' h 2 M '+fmt(right-2)+' '+fmt(top)+' H '+fmt(right)+' V '+fmt(bottom)+' h -2" stroke="black" stroke-width=".55" fill="none"/>');
        parts.push(textRun(String(c.repeat),right+1,bottom+2,6));
      }
      const legend=c.lines.map(line=>/^(\d+[a-z]{0,3})([,，]\s*.+)$/.exec(line));
      if (legend.length>1 && legend.every(Boolean)) {
        const left=cx-Math.max(...c.lines.map(line=>textWidth(line,8)))/2;
        for (const [line,match] of legend.entries()) {
          parts.push('<text x="'+fmt(left)+'" y="'+fmt(labelTop+11+line*10.8)+'" font-size="8"><tspan font-weight="bold">'+esc(match[1])+'</tspan>'+esc(match[2])+'</text>');
        }
      } else drawLines(parts,c.lines,cx,labelTop+3,8,true,'middle');
      parts.push('</g>');
      x += c.width;
    }
  }
  function flowGroup(cards, y) {
    let strip = [];
    function flush() {
      const h = height(strip);
      drawGroup(strip,(width-groupWidth(strip))/2,y+h/2,y+h);
      y += h+labelHeight(strip)+rowGap;
      strip = [];
    }
    for (const c of cards) {
      if (strip.length && groupWidth([...strip,c])>inner) {
        flush();
        if (c.role !== 'catalyst') y=drawLines(parts,['+'],width/2,y,8,false,'middle')+2;
      }
      strip.push(c);
    }
    if (strip.length) flush();
    return y;
  }
  const hasPlacement = reaction.conditionsAbove != null || reaction.conditionsBelow != null;
  const above = hasPlacement ? (reaction.conditionsAbove ?? []) : (reaction.conditions ? [reaction.conditions] : []);
  const below = reaction.conditionsBelow ?? [];
  const asLine = entry => typeof entry === 'string' ? {text:entry} : entry;
  const ideal = Math.min(inner, Math.max(42,...[...above,...below].flatMap(e=>asLine(e).text.split('\n').map(line=>textWidth(line,7.5)+4))));
  const left = groupWidth(reactants), right = groupWidth(products), catalystW = groupWidth(catalysts);
  const available = inner - left - right - gap*2;
  const minArrow = Math.min(ideal,60);
  const inline = catalysts.length && available-catalystW-12 >= minArrow;
  const horizontal = available >= minArrow;
  const arrow = horizontal ? Math.min(ideal,available-(inline ? catalystW+12 : 0)) : Math.min(ideal,inner);
  const linesFor = entries => entries.flatMap(entry=>{
    const {text,color='black'}=asLine(entry);
    return wrap(text,arrow-2,7.5).map(line=>({line,color}));
  });
  const upper = linesFor(above), lower = linesFor(below);
  function conditions(rows, x, y, side) {
    parts.push('<g data-condition-side="'+side+'">');
    for (const {line,color} of rows) {
      parts.push('<g fill="'+color+'">'+textRun(line,x,y+7.5,7.5,false,'middle')+'</g>');
      y += 10.125;
    }
    parts.push('</g>');
    return y;
  }
  let y = 3;
  if (horizontal) {
    const cards = [...reactants,...products,...(inline ? catalysts : [])];
    const halfHeight = height(cards)/2;
    const cy = y+Math.max(halfHeight,upper.length*10.125+4);
    const x = (width-left-right-arrow-gap*2-(inline ? catalystW+12 : 0))/2;
    const ax = x+left+gap, end = ax+arrow;
    const labelTop = cy+halfHeight;
    drawGroup(reactants,x,cy,labelTop);
    conditions(upper,ax+arrow/2,cy-4-upper.length*10.125,'above');
    parts.push('<path data-reaction-arrow="horizontal" d="M '+fmt(ax)+' '+fmt(cy)+' H '+fmt(end)+' l -5 -2 m 5 2 l -5 2" stroke="black" fill="none" stroke-width=".7"/>');
    const conditionBottom = conditions(lower,ax+arrow/2,cy+3,'below');
    drawGroup(products,end+gap,cy,labelTop);
    if (inline) drawGroup(catalysts,end+gap+right+12,cy,labelTop);
    y = Math.max(labelTop+labelHeight(cards),conditionBottom)+rowGap;
  } else {
    y=flowGroup(reactants,y);
    y=conditions(upper,width/2,y,'above');
    parts.push('<path data-reaction-arrow="vertical" d="M '+fmt(width/2)+' '+fmt(y+1)+' v 13 l -2 -4 m 2 4 l 2 -4" stroke="black" fill="none" stroke-width=".7"/>');
    y=conditions(lower,width/2,y+18,'below')+rowGap;
    y=flowGroup(products,y);
  }
  if (!inline) y=flowGroup(catalysts,y);
  return { parts, height:Math.ceil(y+1) };
}

function drawReaction(reaction, drawings, width, scale) {
  if (reaction.conditionsAbove || reaction.conditionsBelow || reaction.labels || reaction.catalystIds?.length) {
    return drawLabeledReaction(reaction,drawings,width,scale);
  }
  const parts = [], inner = width - 2 * MARGIN;
  const left = reaction.reactantIds.map(id => drawings.get(id)), right = reaction.productIds.map(id => drawings.get(id));
  const size = group => group.reduce((n, mol) => n + mol.w * scale, 0) + Math.max(group.length - 1, 0) * 13;
  const tallest = group => Math.max(0, ...group.map(mol => mol.h * scale));
  const groupLine = (group, x, cy) => {
    for (const [i, mol] of group.entries()) {
      if (i) { parts.push(textRun('+', x + 6.5, cy + 3, 10, false, 'middle')); x += 13; }
      parts.push(drawMol(mol, x + mol.w * scale / 2, cy, scale));
      x += mol.w * scale;
    }
  };
  const arrowWidth = Math.max(32, Math.min(100, inner - size(left) - size(right) - 12));
  const conditions = reaction.conditions ? wrap(reaction.conditions, arrowWidth, 7.5) : [];
  let y = 3;
  if (size(left) + size(right) + arrowWidth + 12 <= inner && conditions.length <= 4) {
    const x = (width - size(left) - size(right) - arrowWidth - 12) / 2;
    const cy = y + Math.max(tallest(left) / 2, tallest(right) / 2, conditions.length * 10.125 + 4);
    const ax = x + size(left) + 6, end = ax + arrowWidth;
    groupLine(left, x, cy);
    drawLines(parts, conditions, ax + arrowWidth / 2, cy - 4 - conditions.length * 10.125, 7.5, false, 'middle');
    parts.push(`<path d="M ${fmt(ax)} ${fmt(cy)} H ${fmt(end)} l -5 -2 m 5 2 l -5 2" stroke="black" fill="none" stroke-width="0.7"/>`);
    groupLine(right, end + 6, cy);
    y = cy + Math.max(tallest(left), tallest(right)) / 2 + 4;
  } else {
    const drawSide = group => {
      let line = [];
      const flush = () => { const h = tallest(line); groupLine(line, (width - size(line)) / 2, y + h / 2); y += h + 4; };
      for (const mol of group) {
        if (line.length && size([...line, mol]) > inner) {
          flush();
          parts.push(textRun('+', width / 2, y + 7, 9, false, 'middle'));
          y += 12; line = [];
        }
        line.push(mol);
      }
      if (line.length) flush();
    };
    drawSide(left);
    if (reaction.conditions) y = drawLines(parts, wrap(reaction.conditions, inner, 7.5), width / 2, y, 7.5, false, 'middle');
    parts.push(`<path d="M ${fmt(width / 2)} ${fmt(y + 2)} v 13 l -2 -4 m 2 4 l 2 -4" stroke="black" stroke-width="0.8" fill="none"/>`);
    y += 21;
    drawSide(right);
  }
  return { parts, height: Math.ceil(y) };
}

function drawScopeCard(parts,row,mol,table,x,y,height,scale,textSpace) {
  parts.push(drawMol(mol,x,y+height/2,scale));
  const role = row.structureRole === 'substrate' ? ' (substrate)' : '';
  let end=drawLines(parts,wrap(table.label(row)+role+table.ref(row),textSpace,8.5),x,y+height+4,8.5,true,'middle');
  const detail=[yieldText(row.yield,table.scopeMethod),row.selectivity,row.scale].filter(Boolean).join(', ');
  end=drawLines(parts,wrap(detail,textSpace,8),x,end,8,false,'middle');
  for (const result of additionalYieldLines(row,table.scopeMethod)) {
    end=drawLines(parts,wrap(result,textSpace,7.5),x,end,7.5,false,'middle');
  }
  for (const [key,value] of Object.entries(row.conditions || {})) {
    end=drawLines(parts,wrap(key+': '+value,textSpace,7.5),x,end,7.5,false,'middle');
  }
  return end;
}

function drawScaffoldPanels(parts, panels, table, inner, scale, requestedColumns, y, inBand=false) {
  const columns = Math.min(panels.length, requestedColumns || Math.max(1,Math.floor(inner/200)));
  const panelWidth = inner/columns;
  for (let offset=0; offset<panels.length; offset+=columns) {
    if (!inBand) y+=table.bandGap();
    let bottom=y;
    const strip=panels.slice(offset,offset+columns);
    const availableWidth=panelWidth-6;
    const align=table.scopeStyle.alignPanelLabels && availableWidth<190 && strip.every(panel=>!panel.entry);
    const sharedHeight=align ? Math.max(...strip.map(panel=>
      panel.drawing.h*Math.min(scale,availableWidth/panel.drawing.w) +
      (panel.title ? wrap(panel.title,availableWidth,9).length*9*1.35+3 : 0))) : 0;
    for (const [col,panel] of strip.entries()) {
      const left=MARGIN+col*panelWidth+3, available=panelWidth-6;
      const {drawing, rows, title, substitutions, sites} = panel;
      if (panel.entry) {
        const cardScale=Math.min(scale,available/drawing.w);
        bottom=Math.max(bottom,drawScopeCard(parts,panel.entry,drawing,table,left+available/2,y,drawing.h*cardScale,cardScale,available));
        continue;
      }
      parts.push('<g data-scaffold-group="'+esc(panel.group)+'" data-rgroup-sites="'+esc(sites.join(','))+'">');
      let top=y;
      if (title) top=drawLines(parts,wrap(title,available,9),left,y,9,true)+3;
      const onLeft=!align && available>=140;
      const molSpace=onLeft ? Math.min(available*0.36,125) : available;
      const molScale=Math.min(scale,molSpace/drawing.w);
      const molHeight=drawing.h*molScale;
      const textLeft=onLeft ? left+molSpace+5 : left;
      const textSpace=onLeft ? available-molSpace-5 : available;
      let rowY=align ? y+sharedHeight+3 : onLeft ? top : top+molHeight+3;
      for (const row of rows) {
        const cells=substitutions.get(row.id);
        const info=[table.label(row)+table.ref(row), ...cells.map(cell=>cell.site+' = '+cell.label),
          yieldText(row.yield,table.scopeMethod), row.selectivity, row.scale].filter(Boolean);
        parts.push('<g data-scope-entry="'+esc(row.id)+'" data-linked-compound="'+esc(row.compoundId)+'">');
        const conditions=Object.entries(row.conditions || {});
        if (table.scopeStyle.inlineConditions) info.push(...conditions.map(([key,value])=>key+' = '+value));
        const size=table.scopeStyle.entryFontPt || 8;
        const lines=wrap(info.join(', '),textSpace,size,scaffoldTextWidth);
        if (table.scopeStyle.inlineConditions && lines[0]?.startsWith(info[0])) {
          const first=lines.shift();
          parts.push('<text x="'+fmt(textLeft)+'" y="'+fmt(rowY+size)+'" font-size="'+size+'"><tspan font-weight="bold">'+esc(info[0])+'</tspan>'+esc(first.slice(info[0].length))+'</text>');
          rowY+=size*1.35;
        }
        rowY=drawLines(parts,lines,textLeft,rowY,size);
        for (const result of additionalYieldLines(row,table.scopeMethod)) {
          rowY=drawLines(parts,wrap(result,textSpace,7.5),textLeft,rowY,7.5);
        }
        for (const [key,value] of table.scopeStyle.inlineConditions ? [] : conditions) {
          rowY=drawLines(parts,wrap(key+': '+value,textSpace,7.5),textLeft,rowY,7.5);
        }
        parts.push('</g>'); rowY+=2;
      }
      const molCenter=align ? (top+y+sharedHeight)/2 : onLeft ? top+Math.max(molHeight,rowY-top)/2 : top+molHeight/2;
      parts.push(drawMol(drawing,left+molSpace/2,molCenter,molScale,'data-scaffold-id'),'</g>');
      bottom=Math.max(bottom,top+molHeight,rowY);
    }
    y=bottom+8;
  }
  return y;
}

function drawScope(parts, groups, alignedGroups, drawings, table, width, scale, y, scaffolds, requestedColumns,bands) {
  const inner = width - 2 * MARGIN;
  if (bands) {
    const byId=new Map([...groups.values()].flat().map(row=>[row.id,row]));
    const used=new Set();
    for (const band of bands) {
      y+=table.bandGap();
      if (band.title) {
        parts.push('<g fill="'+esc(band.color || 'black')+'">');
        y=drawLines(parts,wrap(band.title,inner,9),MARGIN,y,9,true)+3;
        parts.push('</g>');
      }
      const panels=band.items.map(({entryId,scaffoldGroup})=>{
        let panel=scaffolds.get(scaffoldGroup);
        if (entryId) {
          const entry=byId.get(entryId);
          if (!entry || scaffolds.has(entry.group)) bad('Unknown or scaffold-owned scope entry '+entryId);
          panel={entry,rows:[entry],drawing:(alignedGroups.get(entry.group) || drawings).get(entry.compoundId)};
        }
        if (!panel) bad('Unknown scope scaffold group '+scaffoldGroup);
        for (const row of panel.rows) {
          if (used.has(row.id)) bad('Duplicate scope band entry '+row.id);
          used.add(row.id);
        }
        return panel;
      });
      y=drawScaffoldPanels(parts,panels,table,inner,scale,panels.length,y,true);
    }
    if (used.size!==byId.size) bad('Scope bands must cover all visible experiments.');
    return y;
  }
  let panels=[];
  for (const [name, rows] of groups) {
    if (scaffolds.has(name)) {
      panels.push(scaffolds.get(name));
      continue;
    }
    if (panels.length) { y=drawScaffoldPanels(parts,panels,table,inner,scale,requestedColumns,y); panels=[]; }
    const library = alignedGroups.get(name) || drawings;
    y+=table.bandGap();
    parts.push(`<g data-scope-group="${esc(name)}" data-scaffold-alignment="${alignedGroups.has(name) ? 'verified' : 'saved-orientations'}">`);
    if (name) {
      y = drawLines(parts, wrap(name, inner, 9), MARGIN, y, 9, true) + 3;
      parts.push(rule(MARGIN, y, width - MARGIN));
      y += 5;
    }
    const widest = Math.max(...rows.map(row => library.get(row.compoundId).w * scale));
    const cols = Math.max(1, Math.min(rows.length, requestedColumns || Math.floor(inner / Math.max(90, widest + 6))));
    const cell = inner / cols;
    const cardScale = requestedColumns ? Math.min(scale,scale*(cell-6)/widest) : scale;
    for (let index = 0; index < rows.length; index += cols) {
      if (index) y+=table.bandGap();
      const strip = rows.slice(index, index + cols);
      const height = Math.max(...strip.map(row => library.get(row.compoundId).h * cardScale));
      let bottom = y;
      for (const [column, row] of strip.entries()) {
        const x = MARGIN + cell * (column + 0.5), mol = library.get(row.compoundId);
        const end=drawScopeCard(parts,row,mol,table,x,y,height,cardScale,cell-5);
        bottom = Math.max(bottom, end);
      }
      y = bottom + 9;
    }
    parts.push('</g>');
  }
  return panels.length ? drawScaffoldPanels(parts,panels,table,inner,scale,requestedColumns,y) : y;
}

function columnBands(headers, width) {
  const capacity = Math.max(2, Math.floor((width - 2 * MARGIN) / 38));
  const bands = [];
  for (let col = 1; col < headers.length; col += capacity - 1) {
    bands.push([0, ...Array.from({length: Math.min(capacity - 1, headers.length - col)}, (_, i) => col + i)]);
  }
  return bands;
}

function drawTable(parts, table, width, y, warnings, bands) {
  const inner = width - 2 * MARGIN, size = 8;
  const {tableHeaders: headers, tableRows: rows} = table;
  if (bands.length > 1) warnings.push({code:'TABLE_COLUMN_BANDS', message:'Condition columns continue in separate blocks with repeated entry identifiers.'});
  for (const indices of bands) {
    const weights = indices.map(i => {
      const longest = Math.max(textWidth(headers[i], size), ...rows.map(row => textWidth(row[i], size)));
      return Math.max(34, Math.min(115, longest + 7));
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(weight => inner * weight / sum);
    const row = (values, bold) => {
      let x = MARGIN, bottom = y;
      for (const [j, i] of indices.entries()) {
        bottom = Math.max(bottom, drawLines(parts, wrap(values[i], widths[j] - 5, size), x + 2.5, y + 2, size, bold));
        x += widths[j];
      }
      y = bottom + 3;
    };
    parts.push(rule(MARGIN, y, width - MARGIN));
    row(headers, true);
    parts.push(rule(MARGIN, y, width - MARGIN));
    for (const values of rows) row(values, false);
    parts.push(rule(MARGIN, y, width - MARGIN)); y += 8;
  }
  return y;
}

function abbreviationsFor(spec,id) {
  const overrides=spec.abbreviationOverrides;
  return overrides && Object.hasOwn(overrides,id) ? overrides[id] : spec.abbreviations;
}
async function prepareReactionDrawings(document, spec, entryIds = []) {
  const reaction = spec.reaction && {...spec.reaction};
  for (const id of Object.keys(spec.abbreviationOverrides || {})) {
    if (document.objects[id]?.kind!=='molecule') bad('Missing saved molecule for abbreviation override: '+id);
  }
  const drawings = new Map();
  const ids = new Set([...entryIds, ...(reaction?.reactantIds || []), ...(reaction?.productIds || []), ...(reaction?.catalystIds || [])]);
  for (const id of ids) {
    const object = document.objects[id];
    if (object?.kind !== 'molecule') bad(`Missing saved molecule: ${id}`);
    const result = await renderMolecule(object.data,{abbreviations:abbreviationsFor(spec,id)});
    drawings.set(id, {...moleculeDrawing(result.svg, id), title:object.title});
  }
  if (reaction) {
    for (const role of ['reactant','product']) {
      const side=role+'Ids', templates=reaction[role+'Templates'] || [];
      reaction[side]=[...(reaction[side] || [])];
      for (const [i,template] of templates.entries()) {
        let id='header-'+role+'-'+i;
        while (drawings.has(id) || Object.hasOwn(reaction.labels ?? {},id)) id+='-';
        const graphic=moleculeDrawing(await headerTemplateSvg({abbreviations:spec.abbreviations,...template}),id);
        graphic.body='<g data-header-template="'+role+'" data-variable-attachments="'+(template.ringAttachments?.length || 0)+'">'+graphic.body+'</g>';
        drawings.set(id,graphic);
        reaction[side].push(id);
        if (template.label) reaction.labels={...reaction.labels,[id]:template.label};
      }
      if (!reaction[side].length) bad('A reaction requires reactant and product structures.');
    }
  }
  return {drawings, reaction};
}

function commonBondScale(drawings, width) {
  const widest = Math.max(1, ...drawings.map(mol => mol.w));
  return Math.min(BASE_SCALE, (width - 2 * MARGIN - 2) / widest);
}

function reactionArtwork(reaction, drawings, width, scale) {
  const header = drawReaction(reaction, drawings, width, scale);
  return {...header, svg:svgDocument(header.parts, width, header.height, 'Reaction')};
}

export async function renderReactionSvg(document, specification) {
  const {journal, columns} = specification;
  const profile = PROFILES[journal];
  if (!profile || ![1, 2].includes(columns)) bad('Choose a supported journal and one or two columns.');
  const width = profile.widths[columns-1] / MM_PER_PT;
  const {drawings, reaction} = await prepareReactionDrawings(document, specification);
  return reactionArtwork(reaction, drawings, width, commonBondScale([...drawings.values()], width)).svg;
}

export async function renderPublication(document, spec) {
  const profile = PROFILES[spec.journal];
  if (!profile || ![1, 2].includes(spec.columns)) bad('Choose a supported journal and one or two columns.');
  if (!['scope', 'optimization'].includes(spec.kind)) bad('Unknown publication kind.');
  const reactionOnly = spec.kind === 'scope' && spec.scopeStyle?.reactionOnly;
  if (reactionOnly && !spec.reaction) bad('A reaction-only figure requires a reaction.');
  const scopePanels = spec.kind === 'scope' && !reactionOnly;
  const rows = spec.experiments.filter(row => (!row.include || row.include.includes(spec.kind)) && (!scopePanels || row.compoundId));
  if (!rows.length) bad(spec.kind === 'scope' ? 'No scope entries contain saved compounds.' : 'No optimization entries were selected.');
  const warnings = [], widthMm = profile.widths[spec.columns - 1], width = widthMm / MM_PER_PT;
  const alignedGroups = new Map(), groups = groupRows(rows);
  const scaffolds = new Map();
  if (scopePanels) {
    for (const definition of spec.scaffoldGroups || []) {
      const entries = groups.get(definition.group);
      if (!entries || scaffolds.has(definition.group)) bad('Scaffold group must refer to a unique populated scope group: '+definition.group);
      const template={abbreviations:spec.abbreviations,...definition};
      const resolved = definition.ringVariation
        ? await resolveRingScope(document,template,entries)
        : await resolveScaffoldGroup(document,template,entries);
      scaffolds.set(definition.group,{...resolved,...definition,rows:entries,drawing:moleculeDrawing(resolved.svg,definition.group)});
    }
  }
  const entryIds = scopePanels ? rows.map(row => row.compoundId) : [];
  const {drawings, reaction} = await prepareReactionDrawings(document, spec, entryIds);
  if (scopePanels && spec.alignScaffolds !== false) {
    let tried = 0;
    for (const [group, entries] of groups) {
      if (scaffolds.has(group)) continue;
      const unique = [...new Set(entries.map(row => row.compoundId))];
      if (unique.length < 2) continue;
      const eligible = tried++ < 8 && unique.length <= 32 && unique.every(id => document.objects[id].data.atoms?.length <= 160);
      const aligned = eligible ? await alignGroup(document, unique, drawings, spec) : null;
      if (aligned) alignedGroups.set(group, aligned);
      else warnings.push({code:'SCAFFOLD_ALIGNMENT_UNCONFIRMED', message:`Saved orientations retained for ${group || 'ungrouped compounds'}; a unique common scaffold alignment was not verified.`});
    }
  }
  const allDrawings = [...drawings.values(), ...[...alignedGroups.values()].flatMap(group => [...group.values()])];
  const scale = commonBondScale(allDrawings, width);
  if (scale < BASE_SCALE) warnings.push({code:'MOLECULE_SCALE_REDUCED', message:'A large structure required a smaller common bond scale. Review atom label sizes at print width.'});
  const parts = [], table = tableData(document, spec, rows);
  const style=table.scopeStyle;
  let y = style.titleInCaption ? MARGIN : drawLines(parts, wrap(spec.title, width - 2 * MARGIN, 10), MARGIN, MARGIN, 10, true) + 5;
  let reactionSvg;
  if (reaction) {
    const header = reactionArtwork(reaction, drawings, width, scale);
    reactionSvg = header.svg;
    parts.push(`<g transform="translate(0 ${fmt(y)})">${header.parts.join('\n')}</g>`);
    y += header.height + 7;
  }
  const tableColumnBands = columnBands(table.tableHeaders, width);
  const bodyStart=parts.length, bodyTop=y;
  let bands=0;
  table.bandGap=()=>{bands++;return 0;};
  const scopeBody=()=>reactionOnly ? bodyTop : drawScope(parts, groups, alignedGroups, drawings, table, width, scale, bodyTop, scaffolds, spec.scopeColumns, spec.scopeBands);
  y = spec.kind === 'scope' ? scopeBody() : drawTable(parts, table, width, y, warnings, tableColumnBands);
  const captionText=(spec.caption || '').normalize('NFKC').toLowerCase();
  const method=table.scopeMethod?.normalize('NFKC').toLowerCase();
  const methodPrinted=method && (captionText.includes(method+' yield') || captionText.includes('yield method: '+method));
  const caption = [style.titleInCaption ? spec.title.replace(/[:.\s]+$/,'')+':' : '', table.scopeMethod && !methodPrinted ? 'Yield method: '+table.scopeMethod+'.' : '',spec.caption].filter(Boolean).join(' ');
  const footerIndex=parts.length, footerTop=y;
  if (style.captionBand && (caption || table.footnotes.length)) y+=4;
  if (caption) y = drawLines(parts, wrap(caption, width - 2 * MARGIN, 8, style.captionBand ? scaffoldTextWidth : textWidth), MARGIN, y, 8) + 3;
  for (const note of table.footnotes) y = drawLines(parts, wrap(note, width - 2 * MARGIN, 7.5), MARGIN, y, 7.5) + 1;
  const naturalHeight=Math.ceil(y+MARGIN);
  const targetHeight=style.aspectRatio ? width/style.aspectRatio : naturalHeight;
  const height=Math.max(naturalHeight,targetHeight), heightMm = fmt(height * MM_PER_PT);
  if (style.captionBand && (caption || table.footnotes.length)) {
    parts.splice(footerIndex,0,'<rect data-caption-band="" x="0" y="'+fmt(footerTop)+'" width="'+fmt(width)+'" height="'+fmt(naturalHeight-footerTop)+'" fill="#ececec"/>');
  }
  if (height>naturalHeight) {
    const extra=height-naturalHeight;
    const footer=parts.splice(footerIndex);
    parts.length=bodyStart;
    const gap=extra/(bands+1);
    table.bandGap=()=>gap;
    scopeBody();
    if (footer.length) parts.push('<g transform="translate(0 '+fmt(extra)+')">',...footer,'</g>');
  } else if (style.aspectRatio && naturalHeight>targetHeight+1) {
    warnings.push({code:'SCOPE_RATIO_CONTENT_HEIGHT',message:'The figure needs more height than the requested aspect ratio at this type size.'});
  }
  if (style.frame) parts.push('<rect x=".35" y=".35" width="'+fmt(width-.7)+'" height="'+fmt(height-.7)+'" fill="none" stroke="#ccc" stroke-width=".7"/>');
  if (heightMm > profile.maxHeight) warnings.push({code:'PAGE_HEIGHT_EXCEEDED', message:`Artwork is ${heightMm} mm tall. Split entries across panels before submission.`});
  const { tableRows, tableHeaders, footnotes } = table;
  const htmlRow = (values, tag) => '<tr>' + values.map(value => `<${tag}>${esc(value)}</${tag}>`).join('') + '</tr>';
  const tableHtml = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(spec.title) +
    '</title></head><body>' + (reactionSvg || '') + '<table><caption>' + esc(spec.title) + '</caption><thead>' +
    htmlRow(tableHeaders, 'th') + '</thead><tbody>' + tableRows.map(row => htmlRow(row, 'td')).join('') + '</tbody></table>' +
    [caption, ...footnotes].filter(Boolean).map(line => '<p>' + esc(line) + '</p>').join('') + '</body></html>';
  return { svg: svgDocument(parts, width, height, spec.title), tableHtml, tableRows, tableHeaders, tableColumnBands, footnotes, reactionSvg, widthMm, heightMm, title: spec.title, warnings };
}

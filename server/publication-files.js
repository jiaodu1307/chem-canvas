import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import PDFDocument from 'pdfkit';
import svgToPdf from 'svg-to-pdfkit';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import Ajv from 'ajv';
import { additionalYieldsSchema, outsideYieldRange } from './publication-schema.js';
import { normalizeMarkedYield } from '../public/publication-yield.js';

const xmlEscape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const invalid = message => Object.assign(new Error(message), { code: 'VALIDATION' });
const checkExtraYields = new Ajv({ ownProperties: true }).compile(additionalYieldsSchema);
const mmToPoints = mm => mm * 72 / 25.4;
const maxPixels = 100_000_000;
const excelType = 'application/vnd.openxmlformats-officedocument';
const nsRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const nsOffice = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// All SVG inputs come from the publication renderer. It owns pagination and escaping.
function renderOptions() {
  return { font: { loadSystemFonts: true, defaultFontFamily: 'Arial', sansSerifFamily: 'Arial' } };
}

function size(rendering) {
  const { widthMm, heightMm } = rendering;
  if (![widthMm, heightMm].every(n => Number.isFinite(n) && n > 0 && n <= 2000) || !rendering.svg) {
    throw invalid('成品缺少有效的图形或物理尺寸。');
  }
  return { width: mmToPoints(widthMm), height: mmToPoints(heightMm) };
}

async function vectorPdf(rendering) {
  const { width, height } = size(rendering);
  // usvg emits explicit CSS pixel widths (96/inch) plus the original viewBox.
  // Size the root to this PDF viewport in points (72/inch) before conversion.
  const svg = new Resvg(rendering.svg, renderOptions()).toString().replace(/^<svg\b[^>]*>/, root =>
    root.replace(/\bwidth="[^"]+"/,'width="'+width+'"').replace(/\bheight="[^"]+"/,'height="'+height+'"'));
  const doc = new PDFDocument({ size: [width, height], margin: 0, compress: true });
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  // usvg expands nested molecule SVG and converts system font glyphs to paths,
  // including CJK and chemical symbols. All coordinates stay vector in PDF.
  svgToPdf(doc, svg, 0, 0, { width, height, assumePt: true,
    warningCallback: message => { throw invalid('PDF 矢量转换失败。' + message); } });
  doc.end();
  return result;
}

function printTiff(rendering, dpi) {
  const px = mm => Math.max(1, Math.round(mm * dpi / 25.4));
  const width = px(rendering.widthMm), height = px(rendering.heightMm);
  if (width * height > maxPixels) throw invalid(dpi+' dpi 图像超过一亿像素，请拆分图版。');
  // Outline type once; rasterize in strips so a 1200 dpi double-column figure
  // does not allocate a several-hundred-MiB RGBA surface for the whole page.
  const outline = new Resvg(rendering.svg,renderOptions()).toString();
  const sw = Number(outline.match(/<svg\s+width="([\d.eE+-]+)"/)?.[1]);
  const sh = Number(outline.match(/<svg\s+[^>]*?height="([\d.eE+-]+)"/)?.[1]);
  if (!(sw>0 && sh>0) || Math.abs(sh*width/sw-height)>Math.max(3,height/width)) throw invalid('SVG 的宽高比与指定物理尺寸不一致。');
  const rowsPerStrip = Math.min(height,512), strips = [];
  for (let y=0; y<height; y+=rowsPerStrip) {
    const h = Math.min(rowsPerStrip,height-y);
    const clip = '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+h+'"><g transform="translate(0 '+(-y)+') scale('+(width/sw)+' '+(height/sh)+')">'+outline+'</g></svg>';
    const rgba = new Resvg(clip,{background:'white',font:{loadSystemFonts:false}}).render().pixels;
    const rgb = Buffer.alloc(width*h*3);
    for (let i=0,j=0; i<rgba.length; i+=4) {
      rgb[j++] = rgba[i]; rgb[j++] = rgba[i+1]; rgb[j++] = rgba[i+2];
    }
    strips.push(deflateSync(rgb,{level:6}));
  }
  // Classic little-endian TIFF, chunky RGB, Adobe Deflate, inch units.
  const tags = 13, bits = 8 + 2 + tags * 12 + 4, xRes = bits + 6, yRes = xRes + 8;
  const offsets = yRes+8, counts = offsets+4*strips.length, dataStart=counts+4*strips.length;
  const header = Buffer.alloc(dataStart);
  header.write('II', 0); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(tags, 8);
  let offset = 10;
  const tag = (id, type, count, value) => {
    header.writeUInt16LE(id, offset); header.writeUInt16LE(type, offset+2); header.writeUInt32LE(count, offset+4);
    if (count === 1 && type === 3) header.writeUInt16LE(value, offset+8);
    else header.writeUInt32LE(value, offset+8);
    offset += 12;
  };
  tag(256,4,1,width); tag(257,4,1,height); tag(258,3,3,bits);
  tag(259,3,1,8); tag(262,3,1,2); tag(273,4,strips.length,strips.length===1 ? dataStart : offsets); tag(277,3,1,3);
  tag(278,4,1,rowsPerStrip); tag(279,4,strips.length,strips.length===1 ? strips[0].length : counts); tag(282,5,1,xRes); tag(283,5,1,yRes);
  tag(284,3,1,1); tag(296,3,1,2);
  for (let i=0;i<3;i++) header.writeUInt16LE(8,bits+2*i);
  for (const position of [xRes,yRes]) { header.writeUInt32LE(dpi,position); header.writeUInt32LE(1,position+4); }
  let start=dataStart;
  strips.forEach((s,i)=>{header.writeUInt32LE(start,offsets+4*i);header.writeUInt32LE(s.length,counts+4*i); start+=s.length;});
  return Buffer.concat([header,...strips]);
}

function paragraph(value, { bold = false, size = 20, after = 60 } = {}) {
  const lines = String(value ?? '').split(/\r\n|\r|\n/);
  const runs = lines.map(line => '<w:t xml:space="preserve">' + xmlEscape(line) + '</w:t>').join('<w:br/>');
  return '<w:p><w:pPr><w:spacing w:after="'+after+'"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/>' +
    (bold ? '<w:b/>' : '') + '<w:sz w:val="'+size+'"/></w:rPr>'+runs+'</w:r></w:p>';
}

function editableTable(headers, rows, width) {
  if (!Array.isArray(headers) || !headers.length || headers.length > 55 || !Array.isArray(rows) || rows.some(r => !Array.isArray(r) || r.length !== headers.length)) {
    throw invalid('优化表的表头和行列数不一致。');
  }
  const weights = headers.map((key, i) => Math.min(36, Math.max(5, String(key).length, ...rows.map(r => String(r[i] ?? '').length))));
  const sum = weights.reduce((a,b) => a+b, 0);
  const widths = weights.map(weight => Math.floor(width*weight/sum));
  widths[widths.length-1] += width - widths.reduce((a,b) => a+b, 0);
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="10" w:color="242424"/><w:bottom w:val="single" w:sz="10" w:color="242424"/></w:tblBorders>';
  const row = (values, heading) => '<w:tr><w:trPr><w:cantSplit/>' + (heading?'<w:tblHeader/>':'') + '</w:trPr>' +
    values.map((v,i) => '<w:tc><w:tcPr><w:tcW w:w="'+widths[i]+'" w:type="dxa"/>' +
      (heading?'<w:tcBorders><w:bottom w:val="single" w:sz="6" w:color="242424"/></w:tcBorders>':'') +
      '</w:tcPr>'+paragraph(v, {bold:heading,size:18})+'</w:tc>').join('') + '</w:tr>';
  return '<w:tbl><w:tblPr><w:tblW w:w="'+width+'" w:type="dxa"/>'+borders+'<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>'+
    widths.map(w => '<w:gridCol w:w="'+w+'"/>').join('')+'</w:tblGrid>'+row(headers,true)+rows.map(r=>row(r,false)).join('')+'</w:tbl>';
}

function wordReaction(svg, availableTwips) {
  const original = new Resvg(svg, renderOptions());
  if (!original.width || !original.height) throw invalid('反应式没有有效尺寸。');
  const ratio = original.height / original.width;
  const cx = availableTwips * 635;
  const cy = Math.round(cx*ratio);
  if (cy > 9_400_000) throw invalid('反应式在指定栏宽下超出 Word 页面高度，请拆分。');
  const png = new Resvg(svg, {...renderOptions(), fitTo:{mode:'width',value:Math.max(1,Math.round(cx/914400*300))}}).render().asPng();
  const image = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="'+cx+'" cy="'+cy+'"/><wp:docPr id="1" name="Reaction scheme"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Reaction"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdPng"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="rIdSvg"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+cx+'" cy="'+cy+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  return { image, png };
}

function wordTable(rendering, spec) {
  if (spec.kind !== 'optimization') throw invalid('DOCX 导出适用于条件优化表。');
  const pageWidth = 11906, pageHeight = 16838, leftMargin = 900;
  const available = Math.round(mmToPoints(rendering.widthMm)*20);
  if (available > pageWidth - 2*leftMargin) throw invalid('目标表宽超出 Word 页面的可用宽度。');
  const bands = rendering.tableColumnBands ?? [rendering.tableHeaders.map((_,i)=>i)];
  const table = bands.map(indices => editableTable(indices.map(i=>rendering.tableHeaders[i]),
    rendering.tableRows.map(row=>indices.map(i=>row[i])),available)).join(paragraph('',{size:4,after:35}));
  const reaction = rendering.reactionSvg ? wordReaction(rendering.reactionSvg, available) : null;
  const rel = (id,type,target) => '<Relationship Id="'+id+'" Type="'+nsOffice+'/'+type+'" Target="'+target+'"/>';
  const relationships = contents => '<Relationships xmlns="'+nsRel+'">'+contents+'</Relationships>';
  const files = {
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="'+excelType+'.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8(relationships(rel('rId1','officeDocument','word/document.xml'))),
  };
  if (reaction) {
    files['word/_rels/document.xml.rels'] = strToU8(relationships(rel('rIdPng','image','media/reaction.png')+rel('rIdSvg','image','media/reaction.svg')));
    files['word/media/reaction.svg'] = strToU8(rendering.reactionSvg);
    files['word/media/reaction.png'] = reaction.png;
  }
  const document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="'+nsOffice+'" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"><w:body>' +
    (spec.title?paragraph(spec.title,{bold:true,size:24,after:110}):'')+(reaction?.image ?? '')+table+
    (rendering.footnotes ?? []).map(f=>paragraph(f,{size:17})).join('')+(spec.caption?paragraph(spec.caption,{size:19}):'')+
    '<w:sectPr><w:pgSz w:w="'+pageWidth+'" w:h="'+pageHeight+'"/><w:pgMar w:left="'+leftMargin+'" w:right="'+(pageWidth-leftMargin-available)+'" w:top="900" w:bottom="900" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr></w:body></w:document>';
  files['word/document.xml'] = strToU8(document);
  return Buffer.from(zipSync(files,{level:6}));
}

export async function publicationFile(format, rendering, spec) {
  size(rendering);
  switch (String(format).toLowerCase()) {
    case 'svg': return { body:Buffer.from(rendering.svg),contentType:'image/svg+xml',extension:'svg' };
    case 'pdf': return { body:await vectorPdf(rendering),contentType:'application/pdf',extension:'pdf' };
    case 'tif':
    case 'tiff': return { body:printTiff(rendering,spec.journal==='orglett'?1200:600),contentType:'image/tiff',extension:'tiff' };
    case 'docx': return { body:wordTable(rendering,spec),contentType:excelType+'.wordprocessingml.document',extension:'docx' };
    default: throw invalid('不支持该成品格式。');
  }
}

const headerAliases = {
  id: ['entry','entryid','experimentid','实验编号','实验id','条目','条目编号'],
  compoundId: ['structure','moleculeid','objectid','结构','结构id','化合物id','产物结构'],
  label: ['compoundlabel','productlabel','化合物编号','标签','产物编号'],
  group: ['分组','组别'], yield: ['yieldvalue','yield (%)','yield%','收率','产率','收率(%)','产率(%)'],
  method: ['yieldmethod','收率类型','收率方法','测定方法','方法'],
  additionalYields: ['附加收率','附加收率(JSON)','附加收率JSON'], structureRole: ['结构角色'],
  selectivity: ['选择性'], scale: ['规模','规模/用量','反应规模'],
  note: ['notes','备注','脚注','注释'], source: ['来源','出处'], include: ['用途','使用范围'],
};
const headerKey = text => String(text).normalize('NFKC').toLowerCase().replace(/[\s_-]/g,'');
const aliases = new Map(Object.entries(headerAliases).flatMap(([key,items])=>[key,...items].map(name=>[headerKey(name),key])));
const badKeys = new Set(['__proto__','prototype','constructor']);
const importLimits = { id:200, compoundId:200, label:120, group:160, yield:50, method:80, selectivity:200, scale:160, note:1200, source:600 };
const cellString = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';

// This is the same conversion for pasted CSV/TSV and for typed XLSX cells.
export function publicationRows(rows, { sheetName, rowNumbers } = {}) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 2001) throw invalid('请提供表头和 1–500 条实验记录。');
  const clean = rows.map((row,i) => {
    if (!Array.isArray(row) || row.length > 100) throw invalid('第 '+(i+1)+' 行格式无效或列数超过 100。');
    return Array.from(row, value=>{
      if (value == null) return '';
      if (!cellString(value) || String(value).length > 4000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(String(value))) throw invalid('第 '+(i+1)+' 行存在无效或过长的单元格。');
      return String(value).trim();
    });
  });
  const headerIndex = clean.findIndex(row=>row.some(Boolean));
  if (headerIndex < 0) throw invalid('工作表为空。');
  const header = clean[headerIndex], conditionColumns = [], seen = new Set();
  const columns = header.map(value=>{
    const name = value.replace(/^\uFEFF/,'').trim();
    if (!name) return null;
    const conditionPrefix = /^condition\./i.test(name);
    const key = conditionPrefix ? null : aliases.get(headerKey(name));
    const label = conditionPrefix ? name.slice(10).trim() : name;
    if (!label || label.length > 80 || badKeys.has(label)) throw invalid('条件列名无效或超过 80 个字符。');
    const signature = key || 'condition.'+label;
    if (seen.has(signature)) throw invalid('表头中有重复列：'+name);
    seen.add(signature);
    if (!key) conditionColumns.push(label);
    return key ? { key } : { label };
  });
  if (conditionColumns.length > 36) throw invalid('实验表最多支持 36 个条件列。');
  const experiments = [], ids = new Set();
  for (let i=headerIndex+1; i<clean.length; i++) {
    const cells = clean[i];
    if (!cells.some(Boolean)) continue;
    const n = rowNumbers?.[i] ?? i+1;
    const record = {}, conditions = {};
    let yieldValue, method;
    for (let j=0; j<cells.length; j++) {
      const text = cells[j];
      if (!text) continue;
      const column = columns[j];
      if (!column) throw invalid('第 '+n+' 行第 '+(j+1)+' 列没有表头。');
      const limit=column.key ? importLimits[column.key] : 800;
      if (limit && text.length>limit) throw invalid('第 '+n+' 行的 '+(column.key ?? column.label)+' 超过 '+limit+' 个字符。');
      if (!column.key) { conditions[column.label] = text; continue; }
      if (column.key === 'yield') { yieldValue = text; continue; }
      if (column.key === 'method') { method = text; continue; }
      if (column.key === 'additionalYields') {
        let results;
        try { results = JSON.parse(text); }
        catch { throw invalid('第 '+n+' 行附加收率需要 JSON 数组。'); }
        if (!checkExtraYields(results) || results.some(result => outsideYieldRange(result.value))) {
          throw invalid('第 '+n+' 行附加收率格式无效，请检查 value、context 和可选的 method。');
        }
        record.additionalYields = results.map(normalizeMarkedYield);
        continue;
      }
      if (column.key === 'structureRole') {
        const roles = {product:'product', substrate:'substrate', 产物:'product', 底物:'substrate'};
        const role = text.toLowerCase();
        if (!Object.hasOwn(roles,role)) throw invalid('第 '+n+' 行结构角色须为产物或底物。');
        record.structureRole = roles[role];
        continue;
      }
      if (column.key === 'include') {
        const options = {scope:'scope',optimization:'optimization','底物范围':'scope','范围':'scope','条件优化':'optimization','优化':'optimization'};
        const parts = text.toLowerCase().split(/[|,，、;/]+/).map(v=>v.trim());
        if (parts.some(v=>!Object.hasOwn(options,v))) throw invalid('第 '+n+' 行的用途须为 scope、optimization 或两者。');
        record.include = [...new Set(parts.map(v=>options[v]))]; continue;
      }
      record[column.key] = text;
    }
    if (method && yieldValue === undefined) throw invalid('第 '+n+' 行给出了收率方法，但收率为空。');
    if (outsideYieldRange(yieldValue)) throw invalid('第 '+n+' 行主收率超出 0–100。');
    if (yieldValue !== undefined) record.yield = normalizeMarkedYield({value:yieldValue,...(method?{method}:{})});
    if (Object.keys(conditions).length) record.conditions = conditions;
    if (!record.source && sheetName) record.source = sheetName+'!'+n;
    if (record.id && ids.has(record.id)) throw invalid('实验 ID 重复：'+record.id);
    if (record.id) ids.add(record.id);
    experiments.push(record);
    if (experiments.length>500) throw invalid('实验记录超过 500 条。');
  }
  if (!experiments.length) throw invalid('表头后没有实验记录。');
  let suffix = 1;
  for (const record of experiments) if (!record.id) {
    while (ids.has('exp-'+suffix)) suffix++;
    record.id = 'exp-'+suffix++; ids.add(record.id);
  }
  return { experiments, conditionColumns };
}

function workbookParts(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 8*1024*1024 || bytes.length < 22) throw invalid('XLSX 输入须为 8 MiB 以内的工作簿。');
  let entries = 0, sum = 0;
  const seen = new Set();
  const files = unzipSync(bytes,{ filter(file) {
    const name = file.name;
    if (++entries>1500 || seen.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw invalid('工作簿包含重复、越界或过多的条目。');
    seen.add(name); sum += file.originalSize;
    if (!Number.isSafeInteger(sum) || sum > 40*1024*1024 || file.originalSize > 10*1024*1024) throw invalid('工作簿解压内容超出上限。');
    return /\.(xml|rels)$/i.test(name) && !name.startsWith('xl/drawings/') && !name.startsWith('xl/charts/');
  }});
  return files;
}

const xmlDecoder = new TextDecoder('utf-8',{fatal:true});
function readXml(files, name, callbacks) {
  if (!Object.hasOwn(files,name)) throw invalid('工作簿缺少 '+name+'。');
  const parser = new SaxesParser({xmlns:true}), stack = [];
  let events = 0;
  parser.on('doctype',()=>{ throw invalid('工作簿 XML 包含不支持的 DTD。'); });
  parser.on('opentag',node=>{
    if (++events>450000 || stack.length>64) throw invalid('工作簿 XML 节点过多或层次过深。');
    stack.push(node.local); callbacks.open?.(node, stack);
  });
  parser.on('closetag',node=>{callbacks.close?.(node, stack); stack.pop();});
  parser.on('text',text=>callbacks.text?.(text, stack));
  parser.on('cdata',text=>callbacks.text?.(text, stack));
  parser.write(xmlDecoder.decode(files[name])).close();
}
const attr = (node,key) => node.attributes[key]?.value;
const relId = node => Object.values(node.attributes).find(a=>a.local==='id' && /\/relationships$/.test(a.uri))?.value;
function related(files, part) {
  const dir = path.posix.dirname(part), base = path.posix.basename(part);
  const links = new Map();
  readXml(files,part ? path.posix.join(dir,'_rels',base+'.rels') : '_rels/.rels', {open(node) {
    if (node.local !== 'Relationship' || attr(node,'TargetMode')==='External') return;
    const target = attr(node,'Target') ?? '', id = attr(node,'Id');
    if (!target || target.includes('\\') || /^[a-z]+:/i.test(target) || !id || links.has(id)) throw invalid('工作簿部件关系无效。');
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(dir,target));
    if (resolved.startsWith('../')) throw invalid('工作簿部件路径越界。');
    links.set(id,{name:resolved,type:(attr(node,'Type') ?? '').split('/').at(-1)});
  }});
  return links;
}
function percentStyles(files, name) {
  const styles = new Set(), custom = new Set(), formats = [];
  readXml(files,name,{open(node,stack) {
    if (node.local==='numFmt') {
      const code = (attr(node,'formatCode') ?? '').replace(/"[^"]*"|\\./g,'');
      if (code.includes('%')) custom.add(Number(attr(node,'numFmtId')));
    }
    if (node.local==='xf' && stack.at(-2)==='cellXfs') formats.push(Number(attr(node,'numFmtId')));
  }});
  formats.forEach((id,index)=>{ if (id===9 || id===10 || custom.has(id)) styles.add(index); });
  return styles;
}
function sharedStrings(files, name) {
  const strings = [];
  let item;
  readXml(files,name,{
    open(node){ if(node.local==='si') item=''; },
    text(text,stack){if(item!==undefined && stack.at(-1)==='t' && !stack.includes('rPh')) item+=text;},
    close(node){if(node.local==='si'){strings.push(item);item=undefined;}}
  });
  return strings;
}

function sheetRows(files, sheet, strings, percent) {
  const rows = [], rowNumbers = [];
  let row, rowNumber=0, cell, nextColumn=0;
  readXml(files,sheet,{
    open(node,stack){
      if (node.local==='row' && stack.at(-2)==='sheetData') {
        const index=attr(node,'r');
        const actual = index ? Number(index) : rowNumber+1;
        if (!Number.isSafeInteger(actual) || actual<=rowNumber || actual>1048576) throw invalid('工作表行号无效。');
        rowNumber=actual;row=[];nextColumn=0;
      }
      if (row && node.local==='c' && stack.at(-2)==='row') {
        const ref=attr(node,'r');
        let col=nextColumn;
        if (ref) {
          const m=/^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
          if(!m || Number(m[2])!==rowNumber)throw invalid('单元格地址无效：'+ref);
          col=0;for(const letter of m[1])col=col*26+letter.charCodeAt(0)-64;
          col--;
        }
        if (col<nextColumn || col>16383) throw invalid('单元格列顺序无效。');
        cell={col,ref:ref ?? '行 '+rowNumber,type:attr(node,'t') ?? 'n',style:Number(attr(node,'s') ?? 0),v:'',inline:'',formula:false,hasV:false};
        nextColumn=col+1;
      }
      if (cell && node.local==='f') cell.formula=true;
      if (cell && node.local==='v') cell.hasV=true;
    },
    text(text,stack){
      if (!cell) return;
      if (stack.at(-1)==='v') cell.v+=text;
      if (stack.at(-1)==='t' && stack.includes('is') && !stack.includes('rPh')) cell.inline+=text;
    },
    close(node){
      if (cell && node.local==='c') {
        const {col,ref,type,style,v,inline,formula,hasV}=cell;cell=undefined;
        if (type==='e' || formula && (!hasV || !v)) throw invalid('单元格 '+ref+' 包含错误或未计算的公式。请粘贴计算结果。');
        let value=v;
        if(type==='inlineStr') value=inline;
        else if(type==='s' && hasV) {
          if(!/^\d+$/.test(v) || Number(v)>=strings.length) throw invalid('共享字符串索引无效：'+ref);
          value=strings[Number(v)];
        } else if(type==='n' && percent.has(style) && v!=='' && Number.isFinite(Number(v))) value=Number((Number(v)*100).toPrecision(12))+'%';
        if (value!=='') {
          if(col>=100 || value.length>4000) throw invalid('实验数据超过列数或单元格长度上限。');
          row[col]=value;
        }
      }
      if (row && node.local==='row') {
        if (row.length) { rows.push(row);rowNumbers.push(rowNumber); }
        if (rows.length>501) throw invalid('实验记录超过 500 条。');
        row=undefined;
      }
    }
  });
  return { rows, rowNumbers };
}

export function importPublicationXlsx(bytes, {sheetName, listOnly = false} = {}) {
  try {
    const files=workbookParts(bytes);
    const book=[...related(files,'').values()].find(r=>r.type==='officeDocument');
    if(!book)throw invalid('文件不是 Excel 工作簿。');
    const links=related(files,book.name), sheets = new Map();
    readXml(files,book.name,{open(node,stack) {
      if (node.local!=='sheet' || stack.at(-2)!=='sheets' || ['hidden','veryHidden'].includes(attr(node,'state'))) return;
      const name=attr(node,'name'), link=links.get(relId(node));
      if (!link) throw invalid('工作表缺少部件关系。');
      if (link.type!=='worksheet') return;
      if (!name || sheets.has(name)) throw invalid('工作表缺少名称或名称重复。');
      sheets.set(name,link.name);
    }});
    const worksheets=[...sheets.keys()];
    if (!worksheets.length) throw invalid('未找到可见的实验工作表。');
    const worksheet=sheetName ?? worksheets[0];
    if (!sheets.has(worksheet)) throw invalid('未找到指定的可见工作表。');
    if (listOnly) return {worksheets,worksheet};
    const target=type=>[...links.values()].find(r=>r.type===type)?.name;
    const shared=target('sharedStrings'), styles=target('styles');
    const parsed=sheetRows(files,sheets.get(worksheet),shared?sharedStrings(files,shared):[],styles?percentStyles(files,styles):new Set());
    return { ...publicationRows(parsed.rows,{rowNumbers:parsed.rowNumbers,sheetName:worksheet}), worksheets, worksheet };
  } catch (e) {
    if (e.code==='VALIDATION') throw e;
    throw invalid('无法读取 XLSX 工作簿。请检查文件是否完整且未加密。');
  }
}

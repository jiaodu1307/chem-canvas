import {createHash} from 'node:crypto';
import {SaxesParser} from 'saxes';
import {renderMolecule} from '../src/chemistry/index.js';
import {failure} from './store.js';
import {slotOverlayCheck,slotPaintContext} from './svg-slot-overlays.js';

const SVG='http://www.w3.org/2000/svg';
const bad=message=>{throw failure('VALIDATION',message);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const words=s=>new Set(s.split(' '));
const shapes=words('svg g defs marker clipPath linearGradient radialGradient stop path line polyline polygon rect circle ellipse text tspan title desc');
const texts=words('text tspan title desc');
const ids=/^[A-Za-z_][\w.-]{0,126}$/;
const scalar='[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?';
const length=new RegExp('^('+scalar+')(px|pt|pc|mm|cm|in|em|%)?$');
const presentation=words('fill stroke color stop-color fill-opacity stroke-opacity opacity stop-opacity fill-rule clip-rule stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing text-decoration shape-rendering vector-effect marker-start marker-mid marker-end clip-path paint-order');
const dimensions=words('x y dx dy width height x1 y1 x2 y2 cx cy r rx ry fx fy fr refX refY markerWidth markerHeight textLength offset stroke-width stroke-dashoffset stroke-miterlimit font-size letter-spacing word-spacing');
const attributes=words('id xmlns xml:space viewBox preserveAspectRatio transform gradientTransform markerUnits orient gradientUnits clipPathUnits spreadMethod d points lengthAdjust role aria-label aria-labelledby aria-hidden version');
const paint=words('fill stroke color stop-color');
const numericList=value=>{
  const tokens=value.trim().split(/[\s,]+/);
  return tokens.every(s=>new RegExp('^'+scalar+'$').test(s) && Math.abs(Number(s))<=1e7)?tokens.map(Number):null;
};
const attrText=attrs=>Object.entries(attrs).map(([k,v])=>' '+k+'="'+esc(v)+'"').join('');

function physical(value) {
  const m=String(value).match(length);
  const units={'':1,px:1,pt:96/72,pc:16,in:96,cm:96/2.54,mm:96/25.4};
  return m && Object.hasOwn(units,m[2]||'') ? Number(m[1])*units[m[2]||''] : NaN;
}
function viewport(attrs) {
  const vb=attrs.viewBox && numericList(attrs.viewBox);
  if(attrs.viewBox && (!vb || vb.length!==4 || vb[2]<=0 || vb[3]<=0)) bad('Provide a valid four-number SVG viewBox.');
  const width=attrs.width===undefined?vb?.[2]:physical(attrs.width);
  const height=attrs.height===undefined?vb?.[3]:physical(attrs.height);
  if(!(width>0 && height>0 && width<=16000 && height<=16000 && width*height<=25000000)) bad('Provide positive SVG width and height (or a viewBox) within 25 megapixels.');
  attrs.xmlns=SVG;
  attrs.width??=String(width);attrs.height??=String(height);
  return {width,height};
}

function compile(source) {
  if(typeof source!=='string' || !source.trim() || Buffer.byteLength(source)>512*1024) bad('Provide one static SVG document up to 512 KiB.');
  const chunks=[],stack=[],identified=new Map(),references=[];
  const overlays=slotOverlayCheck(physical);
  let size,count=0,slotCount=0;
  const p=new SaxesParser({xmlns:true});
  function check(key,value,inDefinition) {
    if(!(attributes.has(key)||presentation.has(key)||dimensions.has(key))) bad('Unsupported SVG attribute '+key+'.');
    if(key==='xmlns') {if(value!==SVG)bad('Unsupported SVG namespace.');return;}
    if(key==='xml:space') {if(!['default','preserve'].includes(value))bad('Invalid xml:space.');return;}
    if(key==='id') {if(!ids.test(value)||identified.has(value))bad('Invalid or repeated SVG id.');return;}
    if(key==='aria-label')return;
    if(key==='aria-labelledby') {if(!value.trim().split(/\s+/).every(v=>ids.test(v)))bad('Invalid accessibility label reference.');return;}
    if(key==='viewBox'||key==='points'||key==='stroke-dasharray'||key==='dx'||key==='dy') {
      if(key==='stroke-dasharray' && value==='none')return;
      if(numericList(value))return;
      if(key!=='dx' && key!=='dy')bad('Invalid numeric list in '+key+'.');
    }
    if(dimensions.has(key)) {
      if(!length.test(value)||Math.abs(Number(value.match(length)[1]))>1e7)bad('Invalid length in '+key+'.');
      return;
    }
    const paintRef=key==='fill'||key==='stroke';
    const linkType=key.startsWith('marker-')?'marker':key==='clip-path'?'clipPath':null;
    if(paintRef || linkType) {
      const match=value.match(/^url\(#([A-Za-z_][\w.-]{0,126})\)$/);
      if(match) {
        if(linkType && inDefinition)bad('Nested clipping and marker references are unsupported.');
        references.push({id:match[1],allowed:paintRef?['linearGradient','radialGradient']:[linkType]});
        return;
      }
      if(linkType && value!=='none')bad('Only local SVG definitions may be referenced.');
    }
    if(paint.has(key)) {
      if(!/^(?:[a-z]+|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.%\s,+/\-]+\))$/i.test(value))bad('Unsupported paint value in '+key+'.');
      return;
    }
    if(key==='transform'||key==='gradientTransform') {
      if(!/^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\([\s\dEe.,+\-]+\)\s*,?)+$/.test(value.trim()) ||
          [...value.matchAll(/\(([^()]*)\)/g)].some(m=>!numericList(m[1]))) bad('Invalid SVG transform.');
      return;
    }
    if(key==='d') {
      if(!/^[MmZzLlHhVvCcSsQqTtAa\dEe.,\s+\-]+$/.test(value))bad('Invalid SVG path data.');
      return;
    }
    if(key==='font-family') {
      if(!/^[\p{L}\p{N}\s,"'_-]+$/u.test(value))bad('Invalid font family.');
      return;
    }
    // Remaining fields are keywords, ordinary numbers or lists of keywords.
    if(!/^[A-Za-z\d.\s_%+\-]+$/.test(value))bad('Unsupported SVG value in '+key+'.');
  }
  p.on('doctype',()=>bad('SVG document types are unsupported.'));
  p.on('processinginstruction',()=>bad('SVG processing instructions are unsupported.'));
  p.on('opentag',tag=>{
    const parent=stack.at(-1),name=tag.name;
    if(++count>25000||stack.length>=64)bad('SVG exceeds the element or nesting limit.');
    if(tag.prefix || (tag.uri && tag.uri!==SVG) || !shapes.has(name))bad('Unsupported SVG element '+name+'.');
    if(!parent && name!=='svg')bad('The document root must be svg.');
    if(parent?.slot)bad('Molecule slots must be empty.');
    if(parent && texts.has(parent.name) && (name!=='tspan'||!['text','tspan'].includes(parent.name)))bad('Unsupported child in SVG text.');
    const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.name,a.value]));
    const inDefinition=Boolean(parent?.inDefinition||['defs','marker','clipPath','linearGradient','radialGradient'].includes(name));
    const parentPaint=parent && ['svg','g'].includes(parent.name) ? parent.paint : null;
    if(Object.hasOwn(attrs,'data-molecule-id')){
      if(!parent||name!=='svg'||inDefinition||++slotCount>500)bad('Use at most 500 molecule slots inside the visible SVG.');
      const allowed=words('data-molecule-id x y width height data-abbreviations');
      if(Object.keys(attrs).some(k=>!allowed.has(k)))bad('Use only data-molecule-id, x, y, width, height and optional data-abbreviations on molecule slots.');
      if(!/^[\w.:-]{1,200}$/.test(attrs['data-molecule-id']))bad('Invalid molecule ID.');
      const box={};
      for(const k of ['x','y','width','height']){
        const n=numericList(attrs[k]??'');
        if(n?.length!==1 || ((k==='width'||k==='height') && n[0]<=0))bad('Provide a numeric molecule slot '+k+'.');
        box[k]=n[0];
      }
      const abbreviation=attrs['data-abbreviations']||'expanded';
      if(!['expanded','journal'].includes(abbreviation))bad('Unknown molecule abbreviation mode.');
      chunks.push({id:attrs['data-molecule-id'],box,abbreviation,clipped:parent.clipped});
      overlays.slot(attrs['data-molecule-id'],box,parentPaint);
      stack.push({name,slot:true});return;
    }
    const style=attrs.style;delete attrs.style;
    if(style!==undefined){
      for(const item of style.split(';').filter(s=>s.trim())){
        const m=item.match(/^\s*([a-z-]+)\s*:\s*([^:;]+?)\s*$/);
        if(!m||!presentation.has(m[1]))bad('Unsupported inline SVG style.');
        attrs[m[1]]=m[2];
      }
    }
    for(const [k,v] of Object.entries(attrs))check(k,v,inDefinition);
    if(attrs.id)identified.set(attrs.id,name);
    if(!parent)size=viewport(attrs);
    const clipped = parent?.clipped || Boolean(attrs['clip-path'] && attrs['clip-path'] !== 'none');
    const paint=slotPaintContext(parentPaint,name,attrs,!parent);
    if(name==='rect')overlays.rect(attrs,paint,count);
    chunks.push('<'+name+attrText(attrs)+'>');stack.push({name,inDefinition,clipped,paint});
  });
  const content=value=>{
    if(stack.at(-1)?.slot && value.trim())bad('Molecule slots must be empty.');
    if(!stack.at(-1)?.slot)chunks.push(esc(value));
  };
  p.on('text',content);p.on('cdata',content);
  p.on('closetag',()=>{const node=stack.pop();if(!node.slot)chunks.push('</'+node.name+'>');});
  try {p.write(source).close();} catch(e){if(e.code==='VALIDATION')throw e;bad('Invalid SVG XML: '+e.message);}
  for(const {id,allowed} of references)if(!allowed.includes(identified.get(id)))bad('Missing or incompatible SVG definition '+id+'.');
  return {chunks,...size,slotOverlays:overlays.report()};
}

export async function renderFigureSvg(document,source) {
  const {chunks,width,height,slotOverlays}=compile(source);
  const objects=document?.objects||{},molecules=new Map(),depictions=new Map(),body=[];
  let bytes=0,clippedSlotCount=0;
  for(const item of chunks) {
    let fragment=item;
    if(typeof item!=='string'){
      const {id,box,abbreviation}=item;
      const object=Object.hasOwn(objects,id)&&objects[id];
      if(object?.kind!=='molecule')bad('Molecule slot does not resolve to a saved molecule: '+id);
      const key=id+'|'+abbreviation;
      if(!depictions.has(key)) {
        const {svg,coordinationCenters}=await renderMolecule(object.data,{abbreviations:abbreviation,includeCoordination:true});
        const native=svg.match(/<svg\b[^>]*\bviewBox=['"]([^'"]+)['"][^>]*>([\s\S]*)<\/svg>/);
        if(!native)bad('Invalid verified molecule depiction.');
        depictions.set(key,{viewBox:native[1],body:native[2],coordinationCenters});
      }
      const inner=depictions.get(key);
      fragment='<svg'+attrText({...box,viewBox:inner.viewBox,preserveAspectRatio:'xMidYMid meet','data-molecule-id':id})+'>'+inner.body+'</svg>';
      if(!molecules.has(id))molecules.set(id,{id,smiles:object.data.smiles,structureSha256:sha(object.data.smiles),occurrences:0,
        ...(inner.coordinationCenters.length ? {coordinationCenters:inner.coordinationCenters} : {})});
      const molecule=molecules.get(id);
      molecule.occurrences++;
      if(item.clipped){
        molecule.clippedOccurrences=(molecule.clippedOccurrences || 0)+1;
        clippedSlotCount++;
      }
    }
    bytes+=Buffer.byteLength(fragment);
    if(bytes>20*1024*1024)bad('Expanded figure exceeds 20 MiB.');
    body.push(fragment);
  }
  return {svg:body.join(''),molecules:[...molecules.values()],width,height,sourceSha256:sha(source),
    checkedChemistry:molecules.size>0,chemistryScope:molecules.size?'bound-molecules-only':'none',
    visibleArtworkVerified:false,clippedSlotCount,slotOverlays};
}

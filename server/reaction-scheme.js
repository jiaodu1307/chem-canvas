import { renderMolecule } from '../src/chemistry/index.js';
import { failure } from './store.js';
import { directedRoute } from './directed-scheme.js';

export const SCHEME_VERSION = '2.0.0';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const text = (s, x, y, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${esc(s)}</text>`;
const label = o => String(o.data?.label || o.title || o.id).replace(/^(?:compound|化合物)\s*/i, '');
const weight = s => [...s].reduce((n,c) => n + (c.charCodeAt(0)>255 ? 1.7 : 1), 0);
function wrap(value, capacity = 32) {
  const result = [];
  for (const paragraph of String(value ?? '').split('\n')) {
    let line = '';
    for (const token of paragraph.split(/(?<=\s|,|;|，|；)/u)) {
      if (line && weight(line + token) > capacity) { result.push(line.trim()); line = ''; }
      // Never split a chemical name or a temperature token merely to fit an arrow.
      line+=token;
    }
    if(line.trim()) result.push(line.trim());
  }
  return result;
}

// Semantic reaction roles drive this view; generic research-card edges never become reaction arrows.
// Molecules are re-rendered from saved MOL with a single shared scale, without changing any graph/coordinates.
export async function reactionScheme(document, options = {}) {
  const layout = document.schemeLayout;
  const partial = Boolean(options.rowWidth && options.rowWidth!==layout?.rowWidth || options.reactionIds && !layout);
  const saved = partial ? null : layout;
  const pageWidth = options.rowWidth ?? saved?.rowWidth ?? 1200;
  if (!Number.isInteger(pageWidth) || pageWidth < 600 || pageWidth > 2400) throw failure('VALIDATION','rowWidth must be 600–2400.');
  const all = Object.values(document.objects ?? {}), relations = Object.values(document.relations ?? {});
  if (options.reactionIds && (!Array.isArray(options.reactionIds) || !options.reactionIds.length || options.reactionIds.some(id => document.objects[id]?.kind !== 'reaction'))) throw failure('VALIDATION','reactionIds must identify saved reactions.');
  const reactions = all.filter(o=>o.kind==='reaction');
  const warnings = [], molecules = new Map();
  const roles = (r,kind) => relations.filter(e=>e.kind===kind && (kind==='product'?e.from===r.id:e.to===r.id)).map(e=>document.objects[kind==='product'?e.to:e.from]);
  const asStep=o=>({object:o,reactants:roles(o,'reactant'),products:roles(o,'product'),agents:['reagent','catalyst','solvent'].flatMap(k=>roles(o,k))});
  const requested=options.reactionIds;
  let steps=reactions.filter(o=>saved || !requested || requested.includes(o.id)).map(asStep);
  // A crop of a catalyst cycle needs both adjoining states, even when the
  // transition carrying schemeCycle lies outside the requested crop.
  if(requested && reactions.some(r=>r.data.schemeCycle===true)){
    const {cycleCropContext}=await import('./reaction-cycle.js');
    steps=cycleCropContext(reactions.map(asStep),requested) ?? steps;
  }
  if (steps.length > 80) throw failure('VALIDATION','Select at most 80 reactions.');
  const directed=steps.some(s=>s.object.data.arrowDirection!==undefined || s.object.data.schemeCaption || [...s.reactants,...s.products].some(o=>o?.kind==='note'));
  for(const s of steps) {
    if(!s.reactants.length || !s.products.length || [...s.reactants,...s.products].some(o=>!o || (o.kind!=='molecule' && !(o.kind==='note' && String(o.data?.label || o.title).trim())))) throw failure('VALIDATION',`Reaction ${s.object.id} requires molecular or explicitly labelled reactants and products.`);
    for(const o of [...s.reactants,...s.products]) if(!molecules.has(o.id)) {
      if(o.kind==='note'){
        const labels=wrap(label(o),24);
        molecules.set(o.id,{object:o,labels,w:Math.max(36,...labels.map(line=>weight(line)*10+10))});
        continue;
      }
      const {svg} = await renderMolecule(o.data), match = svg.match(/viewBox=['"]([\d.\s-]+)['"]/);
      if(!match) throw failure('VALIDATION',`Missing molecular viewBox: ${o.id}`);
      const [, , w, h] = match[1].trim().split(/\s+/).map(Number), scale = 24 / 14.4;
      if(![w,h].every(n=>Number.isFinite(n)&&n>0)) throw failure('VALIDATION','Invalid molecular bounds.');
      const labels = wrap(label(o), 24);
      molecules.set(o.id,{object:o,svg,w:Math.max(w*scale,90,...labels.map(l=>weight(l)*8)),imageW:w*scale,h:h*scale,labels});
    }
  }
  if(steps.some(s=>s.object.data.schemeCycle===true)){
    const {renderReactionCycle}=await import('./reaction-cycle.js');
    return renderReactionCycle({document,options,saved,pageWidth,steps,molecules,rendererVersion:SCHEME_VERSION});
  }
  // Stable topological order; missing step numbers do not cause arbitrary reversed chemistry.
  const producers = new Map();
  for(const s of steps) for(const p of s.products) {const list=producers.get(p.id)||[];list.push(s);producers.set(p.id,list);}
  const pending = new Set(steps), ordered = [];
  const order = s => Number(s.object.data?.stepNumber ?? s.object.title?.match(/(?:step|步骤)\s*(\d+)/i)?.[1] ?? Number.MAX_SAFE_INTEGER);
  while(pending.size) {
    const ready=[...pending].filter(s=>s.reactants.every(r=>(producers.get(r.id)||[]).every(p=>p===s||!pending.has(p)))).sort((a,b)=>order(a)-order(b));
    if(!ready.length) throw failure('VALIDATION','Cyclic or ambiguous reaction dependencies. For a catalyst loop, set schemeCycle:true on one reaction and share the closing molecule ID. For an acyclic route, check the reactant and product links.');
    const s=ready[0];pending.delete(s);ordered.push(s);
  }
  const gap=22, plusWidth=32, rows=[], stepLayout=[], moleculeLayout=[];
  const group = objects => ({kind:'molecules',objects,width:objects.reduce((n,o)=>n+molecules.get(o.id).w,0)+Math.max(0,objects.length-1)*plusWidth});
  let row;
  if(!directed) for(const s of ordered) {
    const d=s.object.data, extra=s.agents.filter(Boolean).map(label).join(', ');
    const above=wrap([d.above ?? d.text ?? '',extra].filter(Boolean).join('\n'));
    const below=wrap([d.below,d.yield].filter(v=>v!=null&&v!=='').join('\n'));
    const arrow={kind:'arrow',step:s,above,below,width:Math.max(160,...[...above,...below].map(l=>weight(l)*7.5+20))};
    const left={...group(s.reactants),owner:s.object.id,role:'reactant'},right={...group(s.products),owner:s.object.id,role:'product'};
    const connects=row && row.last.products.length===1 && s.reactants.length===1 && row.last.products[0].id===s.reactants[0].id;
    const tailWidth=arrow.width+right.width+gap*2;
    if(!connects || (saved?.positions['arrow:'+encodeURIComponent(s.object.id)] ? saved.starts.includes(s.object.id) : row.width+tailWidth>pageWidth-80)) {
      row={items:[left],width:left.width,last:s};rows.push(row);
    }
    row.items.push(arrow,right); row.width+=tailWidth;row.last=s;
  }
  let y=40, width=pageWidth, height=160;
  const parts=[],elements=[],starts=[], displayIds=new Map();
  const place=(id,kind,ref,row,x,y,w,h,body,details={})=>{
    const point=saved?.positions[id]??{x,y};
    const element={id,kind,...ref,row,...point,width:w,height:h,...details};
    elements.push(element);width=Math.max(width,point.x+w+30);height=Math.max(height,point.y+h+30);
    parts.push(`<g data-element-id="${esc(id)}" transform="translate(${point.x} ${point.y})"><rect width="${w}" height="${h}" fill="transparent"/>${body}</g>`);
    return element;
  };
  if(directed){
    const drawing=directedRoute(ordered,molecules,{text,wrap,weight,label});
    starts.push(...drawing.starts);
    const arrows=new Map();
    for(const item of drawing.elements){
      const {id,kind,reactionId,x,y,width:w,height:h,body,...details}=item;
      const placed=place(id,kind,{reactionId},0,x,y,w,h,body,details);
      if(kind==='molecule')moleculeLayout.push(placed);
      if(kind==='arrow')arrows.set(id,placed);
    }
    for(const step of drawing.steps){
      const arrow=arrows.get(step.arrowId);
      stepLayout.push({...step,row:0,x:arrow.x,y:arrow.y,width:arrow.width,
        tail:{x:arrow.x+arrow.tail.x,y:arrow.y+arrow.tail.y},head:{x:arrow.x+arrow.head.x,y:arrow.y+arrow.head.y}});
    }
  }
  for(const [index,row] of rows.entries()) {
    const ms=row.items.filter(item=>item.kind==='molecules').flatMap(item=>item.objects.map(o=>molecules.get(o.id)));
    const arrows=row.items.filter(item=>item.kind==='arrow');starts.push(arrows[0].step.object.id);
    const top=Math.max(50,...ms.map(m=>m.h/2),...arrows.map(a=>a.above.length*20+20));
    const bottom=Math.max(60,...ms.map(m=>m.h/2+22+m.labels.length*18),...arrows.map(a=>a.below.length*20+40));
    const axis=y+top;let x=40, previous=[];
    for(const item of row.items) {
      if(item.kind==='molecules') {
        previous=[];const counts=new Map();
        for(const [indexInGroup,obj] of item.objects.entries()) {
          const m=molecules.get(obj.id),occurrence=counts.get(obj.id)??0;counts.set(obj.id,occurrence+1);
          const suffix=[item.owner,item.role,obj.id,occurrence].map(encodeURIComponent).join(':');
          const image=`<image x="${(m.w-m.imageW)/2}" width="${m.imageW}" height="${m.h}" href="data:image/svg+xml;base64,${Buffer.from(m.svg).toString('base64')}"/>`;
          const labels=m.labels.map((line,idx)=>text(line,m.w/2,m.h+24+idx*18,'text-anchor="middle" font-weight="bold"')).join('');
          const element=place('mol:'+suffix,'molecule',{objectId:obj.id,reactionId:item.owner},index,x,axis-m.h/2,m.w,m.h+24+m.labels.length*18,image+labels);
          previous.push(element.id);moleculeLayout.push(element);x+=m.w;
          if(indexInGroup<item.objects.length-1){place('plus:'+suffix,'plus',{reactionId:item.owner},index,x,axis-15,plusWidth,30,text('+',plusWidth/2,21,'text-anchor="middle" font-size="22"'));x+=plusWidth;}
        }
        if(item.role==='product')displayIds.set(item.owner,previous);
      } else {
        const reactionId=item.step.object.id, suffix=encodeURIComponent(reactionId), ref={reactionId};
        const arrow=place('arrow:'+suffix,'arrow',ref,index,x,axis-6,item.width,12,`<path d="M 0 6 H ${item.width-3} m -10 -5 l 10 5 l -10 5" fill="none" stroke="black" stroke-width="1.5"/>`);
        for(const [slot,lines,base] of [['above',item.above,axis-11-item.above.length*20],['below',[...item.below,item.step.object.data.label??item.step.object.title],axis+13]]) {
          if(!lines.length)continue;
          const blockWidth=Math.max(30,...lines.map(line=>weight(String(line))*8.5+10));
          place(slot+':'+suffix,'conditions',ref,index,Math.max(0,x+(item.width-blockWidth)/2),base,blockWidth,lines.length*20,lines.map((line,idx)=>text(line,blockWidth/2,15+idx*20,`text-anchor="middle" font-size="${slot==='below' && idx===lines.length-1?11:14}"`)).join(''),{slot,lines});
        }
        stepLayout.push({reactionId,row:index,x:arrow.x,y:arrow.y+6,width:item.width,arrowId:arrow.id,reactantDisplays:previous,reactants:item.step.reactants.map(o=>o.id),products:item.step.products.map(o=>o.id),above:item.above,below:item.below});x+=item.width;
      }
      x+=gap;
    }
    if(row.width>pageWidth-80)warnings.push({code:'WIDE_REACTION',row:index,message:'Row expanded to preserve readable bonds and conditions.'});
    y+=top+bottom+55;
  }
  if(!directed) for(const step of stepLayout)step.productDisplays=displayIds.get(step.reactionId);
  if(!steps.length)warnings.push({code:'NO_REACTIONS',message:'No saved reaction steps.'});
  const ids=new Set(elements.map(element=>element.id));
  if(saved && (Object.keys(saved.positions).some(id=>!ids.has(id)) || elements.some(element=>!Object.hasOwn(saved.positions,element.id))))warnings.push({code:'TOPOLOGY_CHANGED',message:'Unchanged display IDs retain their positions; review new or removed elements.'});
  const sorted=[...elements].sort((left,right)=>left.x-right.x);
  for(const [idx,left] of sorted.entries())for(let pos=idx+1;pos<sorted.length && sorted[pos].x<left.x+left.width-1 && warnings.length<200;pos++) {
    const right=sorted[pos];if(left.y<right.y+right.height-1 && right.y<left.y+left.height-1)warnings.push({code:'OVERLAP',ids:[left.id,right.id]});
  }
  width=Math.ceil(width);height=Math.ceil(height);
  if(saved && options.reactionIds){
    const steps=stepLayout.filter(step=>options.reactionIds.includes(step.reactionId));
    const displays=new Set(steps.flatMap(step=>[...step.reactantDisplays,...step.productDisplays]));
    const subset=elements.filter(item=>displays.has(item.id)||options.reactionIds.includes(item.reactionId));
    const included=new Set(subset.map(item=>item.id));
    const x=Math.max(0,Math.floor(Math.min(...subset.map(item=>item.x))-25)), y=Math.max(0,Math.floor(Math.min(...subset.map(item=>item.y))-25));
    width=Math.ceil(Math.max(...subset.map(item=>item.x+item.width))+25-x);height=Math.ceil(Math.max(...subset.map(item=>item.y+item.height))+25-y);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}"><rect x="${x}" y="${y}" width="100%" height="100%" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" font-size="16" fill="black">${parts.filter((part,index)=>included.has(elements[index].id)).join('')}</g></svg>`;
    return {documentId:document.id,revision:document.revision,layoutVersion:layout.version,state:'saved',layoutSource:'saved-crop',representation:'reaction-scheme',rendererVersion:SCHEME_VERSION,bounds:{x,y,width,height},width,height,steps,elements:subset,molecules:subset.filter(item=>item.kind==='molecule'),warnings:warnings.filter(item=>!item.ids||item.ids.every(id=>included.has(id))),svg};
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" font-size="16" fill="black">${parts.join('')}</g></svg>`;
  return {documentId:document.id,revision:document.revision,layoutVersion:layout?.version??0,state:'saved',layoutSource:partial?'automatic-inspection':saved?'saved-layout':'automatic-draft',canUndoLayout:document.history?.at(-1)?.schemeEdit===true,canUndoImport:Boolean(document.history?.at(-1)?.cdxmlImport && document.history.at(-1).reversible),representation:'reaction-scheme',rendererVersion:SCHEME_VERSION,width,height,bounds:{x:0,y:0,width,height},rowWidth:pageWidth,starts,elements,steps:stepLayout,molecules:moleculeLayout,warnings,quality:{arrowCount:steps.length,renderedSteps:stepLayout.length,sharedBondScale:true,conditionsTruncated:0,layoutReview:'pending'},svg};
}

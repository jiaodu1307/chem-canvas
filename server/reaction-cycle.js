import {failure} from './store.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const fmt = n => Number(n.toFixed(2));
const point = (x,y) => ({x,y});
const center = box => point(box.x+box.width/2,box.y+box.height/2);
const shift = (p, direction, distance) => point(p.x+direction.x*distance,p.y+direction.y*distance);
const midpoint = (a,b) => point((a.x+b.x)/2,(a.y+b.y)/2);
const overlaps = (a,b,padding=0) => a.x<b.x+b.width+padding && b.x<a.x+a.width+padding &&
  a.y<b.y+b.height+padding && b.y<a.y+a.height+padding;
const vector = (a,b) => {
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
  if (!length) return point(1,0);
  return point(dx/length,dy/length);
};
const enc = encodeURIComponent;

// Each reaction must have exactly one state from its predecessor and supply
// exactly one state to its successor. Other reactants and products are side species.
function orderedCycle(steps) {
  const consumed=new Set(steps.flatMap(s=>s.reactants.map(o=>o.id)));
  const produced=new Set(steps.flatMap(s=>s.products.map(o=>o.id)));
  const byInput=new Map();
  const invalid=()=>{throw failure('VALIDATION','schemeCycle requires one closed loop of distinct molecular states, with one shared reactant and product per step. Use the same saved state ID on the closing edge. Use separate IDs for distinct states.');};
  for (const step of steps) {
    const inputs=step.reactants.filter(o=>produced.has(o.id)),outputs=step.products.filter(o=>consumed.has(o.id));
    if (inputs.length!==1 || outputs.length!==1 || inputs[0].kind!=='molecule' || outputs[0].kind!=='molecule' ||
      inputs[0].id===outputs[0].id || byInput.has(inputs[0].id)) invalid();
    const input=inputs[0],output=outputs[0];
    byInput.set(input.id,{step,input,output,incoming:step.reactants.filter(o=>o.id!==input.id),outgoing:step.products.filter(o=>o.id!==output.id)});
  }
  const rank=s=>Number(s.step.object.data.stepNumber ?? Number.MAX_SAFE_INTEGER);
  const first=[...byInput.values()].sort((a,b)=>rank(a)-rank(b))[0];
  const ordered=[],seen=new Set();
  let entry=first;
  while (entry && !seen.has(entry.input.id)) {
    seen.add(entry.input.id);
    ordered.push(entry);
    entry=byInput.get(entry.output.id);
  }
  if (!first || entry!==first || ordered.length!==steps.length) invalid();
  return ordered;
}

// A single selected step need not carry the cycle flag. Follow products into
// reactants to find its ring before cropping; two steps that only consume the
// same reagent do not thereby belong to the same cycle.
export function cycleCropContext(steps,selectedIds) {
  if (!selectedIds?.length || !steps.some(s=>s.object.data.schemeCycle===true)) return null;
  const producers=new Map(),consumers=new Map();
  const index=(map,id,step)=>{
    if(!map.has(id)) map.set(id,[]);
    map.get(id).push(step);
  };
  for (const s of steps) {
    for(const o of s.reactants) if(o) index(consumers,o.id,s);
    for(const o of s.products) if(o) index(producers,o.id,s);
  }
  const first=steps.find(s=>s.object.id===selectedIds[0]);
  if(!first) return null;
  const component=new Set([first]);
  for (const s of component) {
    for (const o of s.reactants) for(const predecessor of producers.get(o?.id) || []) component.add(predecessor);
    for (const o of s.products) for(const successor of consumers.get(o?.id) || []) component.add(successor);
  }
  const members=[...component],ids=new Set(members.map(s=>s.object.id));
  if (!selectedIds.every(id=>ids.has(id)) || !members.some(s=>s.object.data.schemeCycle===true)) return null;
  if (members.some(s=>[...s.reactants,...s.products].some(o=>!o))) return null;
  try {orderedCycle(members);}
  catch (error) {if (error.code==='VALIDATION') return null;throw error;}
  // Retain document order for identical/missing step numbers.
  return steps.filter(s=>component.has(s));
}

function endpoint(box, toward) {
  const c=center(box), direction=vector(c,toward);
  const dx=Math.abs(direction.x),dy=Math.abs(direction.y);
  return shift(c,direction,Math.min(dx ? box.width/(2*dx) : Infinity,dy ? box.height/(2*dy) : Infinity)+7);
}

function bezier(a,b,c,t) {
  const u=1-t;
  return point(u*u*a.x+2*t*u*b.x+t*t*c.x,u*u*a.y+2*t*u*b.y+t*t*c.y);
}

function stepLines(step) {
  const data=step.object.data;
  const name=data.label || step.object.title;
  const agents=step.agents.filter(Boolean).map(o=>o.data?.label || o.title);
  const lines=[name,data.above ?? data.text,...agents,data.below,data.yield]
    .filter(v=>v!=null).flatMap(v=>String(v).split('\n')).map(s=>s.trim()).filter(Boolean);
  return [...new Set(lines)];
}

// Connectors have an editable bend handle. Saved molecule positions determine
// the tips each time, so moving a molecule does not detach its incoming arrows.
export function renderReactionCycle({document,options,saved,pageWidth,steps,molecules,rendererVersion}) {
  const ordered=orderedCycle(steps), count=ordered.length;
  const boxes=[],parts=new Map(),states=new Map();
  const key=id=>'cycle-state:'+enc(id);
  const drawings=[...molecules.values()];
  const maxBox=Math.max(...drawings.map(m=>Math.max(m.w,(m.h ?? 0)+24+m.labels.length*18)));
  const radius=Math.max(pageWidth*.24,(maxBox+136)/(2*Math.sin(Math.PI/count)));
  const outer=radius+maxBox*.9+108;
  const size=o=>{
    const m=molecules.get(o.id);
    return {width:m.w,height:o.kind==='note'?Math.max(20,m.labels.length*18):(m.h+22+m.labels.length*18)};
  };
  const radial=t=>point(Math.sin(t),-Math.cos(t));
  function box(id,kind,ref,at,width,height) {
    const item={id,kind,...ref,row:0,x:at.x-width/2,y:at.y-height/2,width,height};
    boxes.push(item);
    return item;
  }
  function molecule(id,obj,reactionId,at,additional) {
    const dim=size(obj);
    return box(id,obj.kind==='note'?'endpoint':'molecule',{objectId:obj.id,reactionId,...additional},at,dim.width,dim.height);
  }
  function handle(id,kind,reactionId,at,attrs) {
    return box(id,kind,{reactionId,...attrs},at,14,14);
  }
  for (const [i,{step,input}] of ordered.entries()) {
    const angle=2*Math.PI*i/count;
    states.set(input.id,molecule(key(input.id),input,step.object.id,shift(point(0,0),radial(angle),radius),{cycleState:true}));
  }
  const transitions=ordered.map(({step,input,output,incoming,outgoing},i)=>{
    const reactionId=step.object.id, halfAngle=2*Math.PI*(i+.5)/count;
    const outward=radial(halfAngle),tangent=point(-outward.y,outward.x);
    const control=shift(point(0,0),outward,radius/Math.cos(Math.min(Math.PI/count,Math.PI/3)));
    const straight=step.object.data.cycleArrow==='straight';
    const midway=midpoint(center(states.get(input.id)),center(states.get(output.id)));
    const arcHandle=handle('arrow:'+enc(reactionId),'arrow',reactionId,straight?midway:control,
      {cycleRole:'transition',fromObjectId:input.id,toObjectId:output.id,shape:straight?'straight':'curved'});
    const lines=stepLines(step);
    const width=Math.max(32,...lines.map(s=>[...s].reduce((n,c)=>n+(c.charCodeAt(0)>255?14:7.6),8)));
    const ringPoint=straight?midway:bezier(center(states.get(input.id)),control,center(states.get(output.id)),.5);
    const labelAt=shift(ringPoint,outward,-(38+Math.abs(outward.x)*width*.42));
    const label=box('below:'+enc(reactionId),'conditions',{reactionId,slot:'below',lines},labelAt,width,Math.max(18,lines.length*18));
    const side=[];
    const entries=[...incoming.map(obj=>({obj,direction:'incoming'})),...outgoing.map(obj=>({obj,direction:'outgoing'}))];
    const gap=Math.max(85,...entries.map(e=>Math.max(size(e.obj).width,size(e.obj).height)))+26;
    for (const [index,{obj,direction}] of entries.entries()) {
      const displacement=(index-(entries.length-1)/2)*gap;
      const at=shift(shift(point(0,0),outward,outer),tangent,displacement);
      const suffix=[reactionId,direction,obj.id,index].map(enc).join(':');
      const display=molecule('side:'+suffix,obj,reactionId,at,{cycleRole:direction});
      const joinFraction=.5+(index-(entries.length-1)/2)*(.45/Math.max(1,entries.length-1));
      const join=bezier(center(states.get(input.id)),straight?midway:control,center(states.get(output.id)),joinFraction);
      const bend=shift(midpoint(at,join),tangent,(direction==='incoming'?1:-1)*20);
      const arrow=handle('branch:'+suffix,'branch',reactionId,bend,{cycleRole:direction,objectId:obj.id});
      side.push({display,arrow,joinFraction,direction});
    }
    return {step,input,output,side,arcHandle,label,straight,outward};
  });
  // Labels share a ring with molecular diagrams of very different widths.
  // Try nearby positions toward the center, in addition to tangential offsets.
  const obstacles=boxes.filter(b=>b.kind==='molecule' || b.kind==='endpoint');
  for (const {label,outward} of transitions) {
    const tangent=point(-outward.y,outward.x);
    const origin=point(label.x,label.y);
    let found=false;
    for (let inward=0;inward<=120 && !found;inward+=10) {
      for (const side of [0,16,-16,32,-32]) {
        const at=shift(shift(origin,outward,-inward),tangent,side);
        const candidate={...at,width:label.width,height:label.height};
        if (obstacles.some(o=>overlaps(o,candidate,6))) continue;
        Object.assign(label,at);found=true;break;
      }
    }
    obstacles.push(label);
  }
  const captions=[...new Set(steps.map(s=>s.object.data.schemeCaption).filter(s=>typeof s==='string' && s.trim()))];
  if (captions.length) {
    const minX=Math.min(...boxes.map(b=>b.x)),maxX=Math.max(...boxes.map(b=>b.x+b.width));
    const width=Math.max(maxX-minX,180),length=Math.max(12,Math.floor((width-25)/8));
    const lines=[];
    for (const caption of captions) for (const paragraph of caption.split('\n')) {
      let line='';
      for (const token of paragraph.split(/\s+/)) {
        if (line && line.length+token.length+1>length) {lines.push(line);line='';}
        line+=(line?' ':'')+token;
      }
      if (line) lines.push(line);
    }
    const height=lines.length*18+14,bottom=Math.max(...boxes.map(b=>b.y+b.height));
    box('caption:cycle','caption',{reactionId:ordered[0].step.object.id,lines},point((minX+maxX)/2,bottom+20+height/2),width,height);
  }
  const left=Math.min(...boxes.map(b=>b.x)), top=Math.min(...boxes.map(b=>b.y));
  const naturalWidth=Math.max(...boxes.map(b=>b.x+b.width))-left+50;
  const translate=point(25-left+Math.max(0,(pageWidth-naturalWidth)/2),25-top);
  for (const b of boxes) {
    const savedPosition=saved?.positions[b.id];
    b.x=fmt(savedPosition?.x ?? b.x+translate.x);b.y=fmt(savedPosition?.y ?? b.y+translate.y);
  }
  const connectorIds=new Set(), layout=[];
  function drawArrow(box,a,control,end) {
    connectorIds.add(box.id);
    const unit=vector(control,end), perp=point(-unit.y,unit.x), tail=shift(end,unit,-10);
    const local=p=>fmt(p.x-box.x)+' '+fmt(p.y-box.y);
    const d='M '+local(a)+' Q '+local(control)+' '+local(end);
    const head='M '+local(shift(tail,perp,4.5))+' L '+local(end)+' L '+local(shift(tail,perp,-4.5));
    box.start=point(fmt(a.x),fmt(a.y));box.end=point(fmt(end.x),fmt(end.y));
    box.control=point(fmt(control.x),fmt(control.y));
    parts.set(box.id,'<path d="'+d+'" fill="none" stroke="transparent" stroke-width="12"/><path data-cycle-arrow="'+box.cycleRole+'" d="'+d+'" fill="none" stroke="black" stroke-width="1.6"/><path d="'+head+'" fill="none" stroke="black" stroke-width="1.6"/>');
  }
  for (const {step,input,output,side,arcHandle,label,straight} of transitions) {
    const source=states.get(input.id),target=states.get(output.id);
    const control=straight?midpoint(center(source),center(target)):center(arcHandle);
    const a=endpoint(source,straight?center(target):control), end=endpoint(target,straight?center(source):control);
    drawArrow(arcHandle,a,control,end);
    for (const branch of side) {
      const {display,arrow,direction}=branch;
      const join=bezier(a,control,end,branch.joinFraction),bend=center(arrow),edge=endpoint(display,bend);
      if (direction==='incoming') drawArrow(arrow,edge,bend,join);
      else drawArrow(arrow,join,bend,edge);
    }
    const roleIds=(list,dir,state)=> {
      const matching=side.filter(s=>s.direction===dir);
      return list.map(o=>o.id===state.objectId?state.id:matching.splice(matching.findIndex(item=>item.display.objectId===o.id),1)[0].display.id);
    };
    layout.push({reactionId:step.object.id,row:0,x:arcHandle.x,y:arcHandle.y,width:arcHandle.width,arrowId:arcHandle.id,
      fromStateId:input.id,toStateId:output.id,branchIds:side.map(s=>s.arrow.id),
      reactants:step.reactants.map(o=>o.id),products:step.products.map(o=>o.id),
      reactantDisplays:roleIds(step.reactants,'incoming',source),productDisplays:roleIds(step.products,'outgoing',target),above:[],below:label.lines});
  }
  const selected=options.reactionIds ? new Set(options.reactionIds) : null;
  const visibleSteps=layout.filter(s=>!selected || selected.has(s.reactionId));
  const visibleMolecules=new Set(visibleSteps.flatMap(s=>[...s.reactantDisplays,...s.productDisplays]));
  const visible=boxes.filter(b=>!selected || selected.has(b.reactionId) || visibleMolecules.has(b.id));
  const warnings=[];
  for (const b of visible) {
    if (b.kind==='molecule') {
      const m=molecules.get(b.objectId);
      const image='<image x="'+fmt((m.w-m.imageW)/2)+'" width="'+fmt(m.imageW)+'" height="'+fmt(m.h)+'" href="data:image/svg+xml;base64,'+Buffer.from(m.svg).toString('base64')+'"/>';
      parts.set(b.id,image+m.labels.map((line,i)=>'<text x="'+fmt(m.w/2)+'" y="'+fmt(m.h+19+i*18)+'" text-anchor="middle" font-weight="bold">'+esc(line)+'</text>').join(''));
    } else if (b.kind==='endpoint') {
      parts.set(b.id,molecules.get(b.objectId).labels.map((line,i)=>'<text x="'+fmt(b.width/2)+'" y="'+(15+i*18)+'" text-anchor="middle">'+esc(line)+'</text>').join(''));
    } else if (b.kind==='caption') {
      parts.set(b.id,'<rect width="'+fmt(b.width)+'" height="'+fmt(b.height)+'" fill="#ededed"/>'+b.lines.map((line,i)=>'<text x="9" y="'+(19+i*18)+'" font-size="14">'+esc(line)+'</text>').join(''));
    } else if (b.kind==='conditions') {
      parts.set(b.id,b.lines.map((line,i)=>'<text x="'+fmt(b.width/2)+'" y="'+(14+i*18)+'" text-anchor="middle" font-size="14">'+esc(line)+'</text>').join(''));
    }
  }
  const solid=visible.filter(b=>!connectorIds.has(b.id));
  for (let i=0;i<solid.length;i++) for (let j=i+1;j<solid.length && warnings.length<200;j++) {
    const a=solid[i],b=solid[j];
    if(overlaps(a,b,-1)) warnings.push({code:'OVERLAP',ids:[a.id,b.id]});
  }
  if (saved && (boxes.some(b=>!saved.positions[b.id]) || boxes.length!==Object.keys(saved.positions).length)) {
    warnings.push({code:'TOPOLOGY_CHANGED',message:'Review new or removed cycle elements.'});
  }
  const corners=visible.flatMap(b=>[point(b.x,b.y),point(b.x+b.width,b.y+b.height),...[b.start,b.control,b.end].filter(Boolean)]);
  const x=selected?Math.floor(Math.min(...corners.map(p=>p.x))-20):0;
  const y=selected?Math.floor(Math.min(...corners.map(p=>p.y))-20):0;
  const width=Math.ceil(Math.max(selected?0:pageWidth,...corners.map(p=>p.x+25))-x);
  const height=Math.ceil(Math.max(...corners.map(p=>p.y+25))-y);
  const bounds={x,y,width,height};
  const groups=[...visible].sort((a,b)=>Number(connectorIds.has(b.id))-Number(connectorIds.has(a.id))).map(b=>{
    return '<g data-element-id="'+esc(b.id)+'" transform="translate('+b.x+' '+b.y+')"><rect width="'+fmt(b.width)+'" height="'+fmt(b.height)+'" fill="transparent"/>'+parts.get(b.id)+'</g>';
  });
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="'+[x,y,width,height].join(' ')+'"><rect x="'+x+'" y="'+y+'" width="100%" height="100%" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" font-size="16" fill="black">'+groups.join('')+'</g></svg>';
  return {documentId:document.id,revision:document.revision,layoutVersion:document.schemeLayout?.version ?? 0,
    state:'saved',layoutSource:selected?(saved?'saved-crop':'automatic-inspection'):saved?'saved-layout':'automatic-draft',
    representation:'reaction-scheme',rendererVersion,rowWidth:pageWidth,width,height,bounds,
    canUndoLayout:document.history?.at(-1)?.schemeEdit===true,canUndoImport:Boolean(document.history?.at(-1)?.cdxmlImport && document.history.at(-1).reversible),
    starts:[ordered[0].step.object.id],elements:visible,molecules:visible.filter(b=>b.kind==='molecule'),steps:visibleSteps,
    cycle:{stateIds:ordered.map(entry=>entry.input.id),reactionIds:layout.map(s=>s.reactionId)},
    quality:{arrowCount:visibleSteps.length,renderedSteps:visibleSteps.length,branchArrowCount:visible.filter(b=>b.kind==='branch').length,sharedBondScale:true,conditionsTruncated:0,layoutReview:'pending'},
    warnings,svg};
}

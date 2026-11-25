import { failure } from './store.js';

const directions = { right:[1,0], down:[0,1], left:[-1,0], up:[0,-1] };
const gap = 22;

// Place successive reactions around the molecule that connects them. A following
// step may turn without rotating the molecule or repeating it on another row.
export function directedRoute(ordered, drawings, {text,wrap,weight,label}) {
  const elements=[], steps=[], starts=[], produced=new Map(), consumed=new Set();
  const lanes=[], laneOf=new Map();
  let lane;
  function element(id,kind,step,x,y,width,height,body,details={}) {
    const item={id,kind,reactionId:step.object.id,x,y,width,height,body,...details};
    elements.push(item);
    if(lane){lane.push(item);laneOf.set(item,lane);}
    return item;
  }
  function size(o) {
    const m=drawings.get(o.id);
    return {w:m.w,h:m.svg ? m.h+24+m.labels.length*18 : m.labels.length*20+4};
  }
  function endpoint(step,o,role,index,cx,cy) {
    const m=drawings.get(o.id),{w,h}=size(o);
    const suffix=[step.object.id,role,o.id,index].map(encodeURIComponent).join(':');
    const image=m.svg ? '<image x="'+(w-m.imageW)/2+'" width="'+m.imageW+'" height="'+m.h+'" href="data:image/svg+xml;base64,'+Buffer.from(m.svg).toString('base64')+'"/>' : '';
    const lines=m.labels.map((line,i)=>text(line,w/2,(m.svg?m.h+24:18)+i*18,'text-anchor="middle" font-weight="bold"')).join('');
    return element((m.svg?'mol:':'label:')+suffix,m.svg?'molecule':'endpointLabel',step,cx-w/2,cy-h/2,w,h,image+lines,{objectId:o.id});
  }
  function center(item) {return {x:item.x+item.width/2,y:item.y+item.height/2};}
  function addPlus(step,role,index,cx,cy) {
    return element('plus:'+encodeURIComponent(step.object.id)+':'+role+':'+index,'plus',step,cx-12,cy-12,24,24,text('+',12,18,'text-anchor="middle" font-size="20"'));
  }
  function conditions(step,slot,lines,x,y) {
    if(!lines.length) return;
    const w=Math.max(25,...lines.map(line=>weight(line)*8.5+10));
    return element(slot+':'+encodeURIComponent(step.object.id),'conditions',step,x-w/2,y,w,lines.length*20,
      lines.map((line,i)=>text(line,w/2,15+i*20,'text-anchor="middle" font-size="14"')).join(''),{slot,lines});
  }
  for(const step of ordered) {
    const d=step.object.data, direction=d.arrowDirection ?? 'right';
    if(!Object.hasOwn(directions,direction))throw failure('VALIDATION','arrowDirection must be right, down, left or up.');
    const [dx,dy]=directions[direction];
    // Reuse a displayed intermediate across consecutive steps. Independent
    // roots and branches begin a new lane, avoiding coincident branches.
    const shared=step.reactants.findIndex(o=>produced.has(o.id) && !consumed.has(o.id));
    const pivotIndex=Math.max(0,shared), pivot=step.reactants[pivotIndex];
    let anchor=shared<0 ? null : produced.get(pivot.id);
    if (anchor) {
      lane=laneOf.get(anchor);
    } else {
      lane=[];lanes.push(lane);
      anchor=endpoint(step,pivot,'reactant',pivotIndex,0,0);
      starts.push(step.object.id);
    }
    const {x:cx,y:cy}=center(anchor);
    const additional=step.reactants.map((object,index)=>({object,index})).filter(x=>x.index!==pivotIndex);
    const above=wrap([d.above ?? d.text ?? '',...step.agents.filter(Boolean).map(label)].filter(Boolean).join('\n'));
    const below=wrap([d.below,d.yield].filter(v=>v!=null && v!=='').join('\n'));
    const annotation=d.label===undefined?[]:wrap(d.label);
    const lower=[...below,...annotation];
    let extent=(dx?anchor.width:anchor.height)/2;
    const reactantDisplays=[];
    reactantDisplays[pivotIndex]=anchor.id;
    // Horizontal co-reactants occupy the same line. On a vertical arrow put
    // them beside its shaft so the incoming intermediate can stay in place.
    const length=dx? Math.max(120,...[...above,...lower].map(line=>weight(line)*8.5+24))
      : Math.max(115,additional.reduce((h,{object})=>h+size(object).h+gap,0),(above.length+lower.length)*20+50);
    if(dx) {
      for(const {index:i,object:o} of additional){
        const w=size(o).w;
        addPlus(step,'reactant',i,cx+dx*(extent+16),cy);
        const item=endpoint(step,o,'reactant',i,cx+dx*(extent+32+w/2),cy);
        reactantDisplays[i]=item.id;extent+=32+w;
      }
    } else {
      let side=0;
      for(const {index:i,object:o} of additional){
        const {w,h}=size(o);
        const sideY=cy+dy*(extent+gap+side+h/2);
        addPlus(step,'reactant',i,cx-27,sideY);
        const item=endpoint(step,o,'reactant',i,cx-49-w/2,sideY);
        reactantDisplays[i]=item.id;side+=h+gap;
      }
    }
    const tx=cx+dx*(extent+gap),ty=cy+dy*(extent+gap);
    const hx=tx+dx*length,hy=ty+dy*length;
    const ax=Math.min(tx,hx)-(dy?6:0),ay=Math.min(ty,hy)-(dx?6:0);
    const tail={x:tx-ax,y:ty-ay},head={x:hx-ax,y:hy-ay};
    const path='M '+tail.x+' '+tail.y+' L '+head.x+' '+head.y+' m '+(-dx*9-dy*5)+' '+(-dy*9+dx*5)+' l '+(dx*9+dy*5)+' '+(dy*9-dx*5)+' l '+(-dx*9+dy*5)+' '+(-dy*9-dx*5);
    const arrow=element('arrow:'+encodeURIComponent(step.object.id),'arrow',step,ax,ay,dx?length:12,dy?length:12,'<path data-direction="'+direction+'" d="'+path+'" fill="none" stroke="black" stroke-width="1.5"/>',{direction,tail,head});
    if(dx){
      conditions(step,'above',above,(tx+hx)/2,ty-above.length*20-8);
      conditions(step,'below',lower,(tx+hx)/2,ty+8);
    }else{
      const lines=[...above,...lower], blockWidth=Math.max(25,...lines.map(line=>weight(line)*8.5+10));
      const cyText=(ty+hy-lines.length*20)/2;
      conditions(step,'above',above,tx+18+blockWidth/2,cyText);
      conditions(step,'below',lower,tx+18+blockWidth/2,cyText+above.length*20);
    }
    const productDisplays=[];
    let after=gap;
    for(const [i,o] of step.products.entries()){
      const {w,h}=size(o),span=dx?w:h;
      if(i){addPlus(step,'product',i,hx+dx*(after+14),hy+dy*(after+14));after+=30;}
      const item=endpoint(step,o,'product',i,hx+dx*(after+span/2),hy+dy*(after+span/2));
      productDisplays.push(item.id);produced.set(o.id,item);after+=span;
    }
    for(const o of step.reactants)consumed.add(o.id);
    steps.push({reactionId:step.object.id,arrowId:arrow.id,direction,reactantDisplays,productDisplays,
      reactants:step.reactants.map(o=>o.id),products:step.products.map(o=>o.id),above,below});
  }
  lane=null;
  let bottom=35;
  for(const group of lanes){
    const minX=Math.min(...group.map(item=>item.x)),minY=Math.min(...group.map(item=>item.y));
    for(const item of group){item.x+=35-minX;item.y+=bottom-minY;}
    bottom=Math.max(...group.map(item=>item.y+item.height))+40;
  }
  for(const step of ordered){
    if(!step.object.data.schemeCaption)continue;
    const lines=wrap(step.object.data.schemeCaption,110);
    const w=Math.max(30,...lines.map(line=>weight(line)*8+14));
    const body=lines.map((line,i)=>text(line,5,16+i*19,'font-size="14"')).join('');
    element('caption:'+encodeURIComponent(step.object.id),'caption',step,35,bottom,w,lines.length*19,body,{lines});
    bottom+=lines.length*19+8;
  }
  return {elements,steps,starts};
}

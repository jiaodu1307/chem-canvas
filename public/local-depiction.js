import { scopedFetch as fetch, scopeUrl, workspacePageUrl } from './workspace-context.js';
// Local depiction operates on saved structures; it never reconstructs a sketch draft.
const node=(tag,attrs={},...children)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k.startsWith('on'))e.addEventListener(k.slice(2).toLowerCase(),v);else if(k in e)e[k]=v;else e.setAttribute(k,v);}e.append(...children);return e;};
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const p=await r.json();if(!r.ok)throw new Error(p.error?.message||'操作失败');return p;}
const symbols={1:'H',6:'C',7:'N',8:'O',9:'F',15:'P',16:'S',17:'Cl',35:'Br',53:'I'};
const counts=q=>q?.display?`标签碰键 ${q.display.labelBondClashes.length} · 标签相叠 ${q.display.labelLabelClashes.length} · 楔线拥挤 ${q.display.wedgeCrowding.length}`:'尚无显示诊断';
export async function openLocalDepiction({objectId,onSaved}){
 if(document.querySelector('.local-depiction-dialog'))return;
 let info,picked=null,candidate=null,operations=null,busy=false,saveRequest=null;
 const error=node('p',{role:'alert',className:'local-depiction-error'});
 const status=node('p',{role:'status'});
 const picture=node('div',{className:'local-depiction-picture'});
 const controls=node('div',{className:'local-depiction-controls'});
 const macro=node('fieldset',{hidden:true,className:'macrocycle-controls'});
 const targets=node('select',{'aria-label':'局部调整目标',onChange:()=>choose(targets.value)});
 const save=node('button',{type:'button',className:'primary',disabled:true,onClick:commit},'保存局部调整');
 const close=node('button',{type:'button',onClick:()=>{if(!busy){dialog.close();dialog.remove();}}},'取消');
 const reload=node('button',{type:'button',onClick:load},'重新读取已保存结构');
 const dialog=node('dialog',{className:'local-depiction-dialog','aria-label':'局部排版'},node('h2',{},'局部排版'),node('p',{},'点击结构中的原子标签或终端键，或从列表选择。大环可展开为横向双链。预览后可继续调节或保存。'),
  node('div',{className:'local-depiction-workspace'},picture,node('aside',{},macro,targets,controls)),status,error,node('div',{className:'local-depiction-actions'},reload,close,save));
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();else dialog.remove();});
 document.body.append(dialog);dialog.showModal();await load();
 async function load(){if(busy)return;busy=true;error.textContent='';save.disabled=true;
  try{info=await api(`/api/molecules/${encodeURIComponent(objectId)}/inspect`);candidate=null;saveRequest=null;operations=null;
   targets.replaceChildren(node('option',{value:''},'选择原子或点击结构'));
   for(const a of info.atoms)targets.append(node('option',{value:a.id},`${symbols[a.atomicNumber]||a.atomicNumber} · 原子 ${a.index+1}${a.terminalHydrogen?' · 显式氢':''}`));
   const selected=info.selection;const id=selected?.objectIds?.[0]===objectId&&!selected.stale&&selected.atomIds?.length===1?selected.atomIds[0]:null;
   picked=info.atoms.find(a=>a.id===(picked?.id||id))||null;targets.value=picked?.id||'';draw(info.svg);renderMacro();renderControls();status.textContent=counts(info.diagnostics);
  }catch(e){error.textContent=e.message;}finally{busy=false;}
 }
 function renderMacro(){
  macro.replaceChildren();macro.hidden=!info.macrocycles?.length;
  if(macro.hidden)return;
  const saved=info.lastAdjustmentReport?.steps?.find(s=>s.type==='doubleChain');
  const ringIds=new Set(info.macrocycles.flat());
  function anchor(label,initial){
   const select=node('select',{'aria-label':label},node('option',{value:''},'自动'));
   for(const a of info.atoms.filter(a=>ringIds.has(a.id))) select.append(node('option',{value:a.id},`${symbols[a.atomicNumber]||a.atomicNumber} · 原子 ${a.index+1}`));
   select.value=initial||'';
   select.onchange=()=>{invalidate();picked=info.atoms.find(a=>a.id===select.value);targets.value=picked?.id||'';draw(info.svg);renderControls();};
   macro.append(node('label',{},label,select));return select;
  }
  macro.append(node('legend',{},'大环双链展开'));
  const left=anchor('左端锚点',saved?.anchors[0]),right=anchor('右端锚点',saved?.anchors[1]);
  function numeric(label,value,min,max){
   const input=node('input',{type:'number','aria-label':label,value,min,max,step:.05,onInput:invalidate});
   macro.append(node('label',{},label,input));return input;
  }
  const span=numeric('横向跨度倍率',saved?.spanScale??1,.75,1.4),gap=numeric('链间距（键长）',saved?.chainGap??3,2,5);
  macro.append(node('button',{type:'button',onClick:async()=>{
   if(Boolean(left.value)!==Boolean(right.value)){error.textContent='请同时选择左右锚点，或将两端都设为自动。';return;}
   const op={type:'doubleChain',spanScale:Number(span.value),chainGap:Number(gap.value)};
   if(left.value)op.anchorIds=[left.value,right.value];
   macro.disabled=true;
   try{await preview([op]);const resolved=candidate?.molecule.depictionAdjustment.steps[0];
    if(resolved){left.value=resolved.anchors[0];right.value=resolved.anchors[1];}
   }finally{macro.disabled=false;}
  }},'预览双链展开'));
 }
 function draw(svg,highlight=true){
  const parsed=new DOMParser().parseFromString(svg,'image/svg+xml');const root=parsed.documentElement;
  if(root.localName!=='svg')throw new Error('结构图无效');
  const allowed=new Set(['svg','g','path','rect','line','polygon','polyline','circle','ellipse','text','tspan','defs','clipPath']);
  for(const e of [root,...root.querySelectorAll('*')]){if(!allowed.has(e.localName)){e.remove();continue;}for(const a of [...e.attributes])if(/^on/i.test(a.name)||/href/i.test(a.name)||/url\(|javascript:/i.test(a.value))e.removeAttribute(a.name);}
  const image=document.importNode(root,true);image.setAttribute('role','img');image.setAttribute('aria-label','可选择局部目标的真实分子结构');image.removeAttribute('width');image.removeAttribute('height');
  image.addEventListener('click',event=>{if(busy)return;const cls=event.target.getAttribute('class')||'';const bond=cls.match(/\bbond-(\d+)\b/);const atom=cls.match(/\batom-(\d+)\b/);
   if(bond){const b=info.bonds.find(b=>b.index===Number(bond[1]));if(b?.terminalAtomIds.length===1)choose(b.terminalAtomIds[0]);else error.textContent='该键不是唯一终端键。请从列表选择要移动的原子；局部旋转不自动移动环或整段骨架。';}
   else if(atom){const a=info.atoms.find(a=>a.index===Number(atom[1]));if(a)choose(a.id);}
  });
  if(highlight&&picked)for(const e of image.querySelectorAll(`[class~="atom-${picked.index}"]`))e.classList.add('local-picked');
  picture.replaceChildren(image);
 }
 function invalidate(){candidate=null;operations=null;saveRequest=null;save.disabled=true;status.textContent='参数已变化，请重新预览。';}
 function choose(id){if(busy)return;picked=info.atoms.find(a=>a.id===id)||null;targets.value=picked?.id||'';invalidate();error.textContent='';draw(info.svg);renderControls();
  if(picked)api('/api/selection',{revision:info.revision,objectIds:[objectId],objectVersion:info.objectVersion,atomIds:[picked.id],bondIds:[]}).catch(e=>{error.textContent=`选区未更新：${e.message}；当前参数仍保留。`;});
 }
 function renderControls(){controls.replaceChildren();if(!picked){controls.append(node('p',{},'选中目标后显示可用操作。'));return;}
  controls.append(node('p',{},`${symbols[picked.atomicNumber]||picked.atomicNumber} · ${picked.degree} 条相邻键`));
  if(picked.terminalHydrogen)controls.append(node('button',{type:'button',onClick:()=>preview([{type:'relaxHydrogens',atomIds:[picked.id]}])},'优化选中氢的位置'));
  if(picked.degree===1){const angle=node('input',{type:'number',value:30,min:-360,max:360,step:5,'aria-label':'终端键旋转角度',onInput:invalidate});const scale=node('input',{type:'number',value:1,min:0.25,max:4,step:0.1,'aria-label':'终端键长度比例',onInput:invalidate});
   controls.append(node('label',{},'旋转角度（°）',angle),node('label',{},'长度比例',scale),node('button',{type:'button',onClick:()=>preview([{type:'rotateTerminalBond',atomId:picked.id,bondId:picked.neighbors[0].bondId,angleDegrees:Number(angle.value),lengthScale:Number(scale.value)}])},'预览终端键调整'));
  }
  const x=node('input',{type:'number',value:picked.x,step:0.1,'aria-label':'分子坐标 X',onInput:invalidate}),y=node('input',{type:'number',value:picked.y,step:0.1,'aria-label':'分子坐标 Y',onInput:invalidate});
  controls.append(node('details',{},node('summary',{},'精确位置'),node('p',{},'MOL 二维坐标，不是屏幕像素。'),node('label',{},'X',x),node('label',{},'Y',y),node('button',{type:'button',onClick:()=>preview([{type:'moveAtom',atomId:picked.id,x:Number(x.value),y:Number(y.value)}])},'预览坐标调整')),
   node('details',{},node('summary',{},'目标标识'),node('code',{},picked.id)));
 }
 async function preview(next){if(busy)return;busy=true;controls.inert=true;macro.inert=true;targets.disabled=true;save.disabled=true;error.textContent='';
  try{const result=await api('/api/molecules/depiction',{operationId:`preview_${crypto.randomUUID()}`,expectedRevision:info.revision,expectedObjectVersion:info.objectVersion,objectId,actor:'human',operations:next,preview:true});
   operations=structuredClone(next);candidate=result;saveRequest=null;draw(result.molecule.svg,false);const report=result.molecule.depictionAdjustment;
   status.textContent=`未保存预览 · 移动 ${result.delta.movedAtoms.length} 个原子。${counts(report.before)} → ${counts(report.after)}`;
   if(report.warnings?.length)error.textContent='仍有局部拥挤，请检查预览。自动诊断不等于视觉合格。';save.disabled=false;
  }catch(e){candidate=null;error.textContent=`${e.message} 当前目标和参数仍保留；冲突时请重新读取。`;}finally{busy=false;controls.inert=false;macro.inert=false;targets.disabled=false;}
 }
 async function commit(){if(busy||!candidate)return;busy=true;save.disabled=true;error.textContent='';
  saveRequest ||= {operationId:`depiction_${crypto.randomUUID()}`,expectedRevision:info.revision,expectedObjectVersion:info.objectVersion,objectId,actor:'human',operations};
  try{const result=await api('/api/molecules/depiction',saveRequest);dialog.close();dialog.remove();onSaved(result.document,objectId);}catch(e){error.textContent=`${e.message} 预览和参数仍保留；重试使用相同请求标识。`;save.disabled=false;}finally{busy=false;}
 }
}

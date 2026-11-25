import { scopedFetch as fetch, workspacePageUrl, projectLocked } from './workspace-context.js';
import {openLocalDepiction} from './local-depiction.js';
import {createSchemeHistory,translateSelection} from './scheme-history.js';
const get=id=>document.getElementById(id), paper=get('paper'), status=get('scheme-status');
let data,busy=false,reflow=false,drag=null,requestId=crypto.randomUUID(),cdxmlAvailable=false,cdxmlImportAvailable=false,importCandidate=null,importImageURL=null;
const moves=new Map(),selection=new Set();
const history=createSchemeHistory();
const snapshot=()=>({data,reflow,moves:[...moves.values()].map(item=>({...item})),selection:[...selection]});
const changed=before=>before.data!==data||before.reflow!==reflow||JSON.stringify(before.moves)!==JSON.stringify([...moves.values()]);
function record(before){if(changed(before))history.record(before);message();}
const dirty=()=>moves.size>0||reflow;
const discard=()=>!dirty()||confirm('放弃尚未保存的布局草稿？');
window.addEventListener('beforeunload',event=>{if(dirty()||importCandidate||busy||document.querySelector('dialog[open]')){event.preventDefault();event.returnValue='';}});
async function api(path,input){const response=await fetch(path,input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{});const payload=await response.json();if(!response.ok)throw Error(payload.error?.message??response.status);return payload;}
function controls(){for(const button of document.querySelectorAll('button:not(.local-depiction-dialog button)'))button.disabled=busy||!data;
  get('draft-undo').disabled=busy||Boolean(drag)||!history.canUndo;get('draft-redo').disabled=busy||Boolean(drag)||!history.canRedo;
  get('undo').disabled=busy||dirty()||!(data?.canUndoDoubleChain||data?.canUndoLayout||data?.canUndoImport);get('undo').textContent=data?.canUndoDoubleChain?'撤销双链展开':data?.canUndoImport?'撤销上次导入':'撤销上次布局保存';for(const id of ['svg','png'])get(id).disabled=busy||dirty()||!data;
  get('cdxml').hidden=get('export-note').hidden=!cdxmlAvailable;
  get('cdxml').disabled=busy||dirty()||data?.layoutSource!=='saved-layout'||!data?.steps.length;
  get('cdxml-import').hidden=get('import-note').hidden=!cdxmlImportAvailable;
  get('cdxml-import').disabled=busy||dirty()||!data;
  get('import-confirm').disabled=busy||!importCandidate;
  get('molecule-depiction').disabled=busy||dirty()||selection.size!==1||element([...selection][0])?.kind!=='molecule';
  get('space').disabled=busy||selection.size<3;get('align').disabled=busy||selection.size<2;
}
function message(){status.textContent=`${dirty()?'未保存草稿':data.layoutSource==='saved-layout'?'已保存布局':'自动初稿'} · 文档 r${data.revision} / 布局 v${data.layoutVersion} · ${data.steps.length} 个反应 · 已选 ${selection.size} 项 · ${data.warnings.length} 条提示${dirty()?'（保存后重新检查）':''}`;controls();}
function render(){paper.replaceChildren(document.importNode(new DOMParser().parseFromString(data.svg,'image/svg+xml').documentElement,true));for(const item of moves.values())node(item.id)?.setAttribute('transform',`translate(${item.x} ${item.y})`);for(const id of selection)node(id)?.classList.add('chosen');get('width').value=data.rowWidth;get('details').textContent=JSON.stringify({warnings:data.warnings,steps:data.steps},null,2);message();}
function show(result){data=result;moves.clear();selection.clear();drag=null;history.clear();requestId=crypto.randomUUID();render();}
function restore(state){if(!state)return;data=state.data;reflow=state.reflow;moves.clear();for(const item of state.moves)moves.set(item.id,{...item});selection.clear();for(const id of state.selection)selection.add(id);requestId=crypto.randomUUID();render();}
function payload(mode){return {expectedRevision:data.revision,expectedLayoutVersion:data.layoutVersion,mode,actor:'human',operationId:requestId,reflow,...(reflow?{rowWidth:data.rowWidth}:{}),moves:[...moves.values()]};}
function bind(id,fn){get(id).onclick=async()=>{if(busy)return;busy=true;controls();try{await fn();}catch(error){status.textContent=`${error.message} 本地草稿未丢弃。`;}finally{busy=false;controls();}};}
async function refresh(){const [result,capabilities]=await Promise.all([api('/api/route/scheme'),api('/api/capabilities')]);cdxmlAvailable=Boolean(capabilities.editing?.reactionScheme?.exports?.cdxml);cdxmlImportAvailable=Boolean(capabilities.editing?.reactionScheme?.imports?.cdxml);reflow=false;show(result);}
bind('refresh',async()=>{if(discard())await refresh();});bind('commit',async()=>{const result=await api('/api/route/scheme/edit',payload('commit'));reflow=false;show(result);});
bind('draft-undo',()=>restore(history.undo(snapshot())));bind('draft-redo',()=>restore(history.redo(snapshot())));
bind('reflow',async()=>{const before=snapshot();const result=await api('/api/route/scheme/edit',{...payload('preview'),moves:[],reflow:true,rowWidth:Number(get('width').value)});data=result;reflow=true;moves.clear();selection.clear();requestId=crypto.randomUUID();history.record(before);render();});
bind('molecule-depiction',async()=>{const objectId=element([...selection][0]).objectId;
  await openLocalDepiction({objectId,onSaved:()=>refresh().catch(e=>{status.textContent=e.message;})});
});
bind('undo',async()=>{await api('/api/undo',{actor:'human',operationId:crypto.randomUUID(),expectedRevision:data.revision});await refresh();});
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`reaction-scheme.${name}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
bind('svg',()=>download(new Blob([data.svg],{type:'image/svg+xml'}),'svg'));bind('png',async()=>{const response=await fetch(`/api/route/scheme.png?revision=${data.revision}`);if(!response.ok)throw Error('文档已变化，请先重新读取');download(await response.blob(),'png');});
bind('cdxml',async()=>{
  const result=await api(`/api/route/scheme/export?format=cdxml&revision=${data.revision}`);
  get('export-warnings').textContent=result.warnings.map(warning=>warning.message||warning.code).join('\n');
  get('export-details').hidden=!result.warnings.length;
  get('export-status').textContent=`已下载文档 r${result.revision} 的 CDXML · ${result.warnings.length} 条兼容提示。ChemDraw 原生编辑兼容性仍待验证。`;
  download(new Blob([result.cdxml],{type:'chemical/x-cdxml;charset=utf-8'}),'cdxml');
});
function clearImport(){importCandidate=null;if(importImageURL)URL.revokeObjectURL(importImageURL);importImageURL=null;get('import-image').removeAttribute('src');}
const importWarningText=warning=>({STYLE_SUBSET:'保留化学结构和可编辑位置；字体、打印设置及原始元数据可能变化。',TEXT_ROLES:'条件和产率按原文字保留，不自动推断为结构化实验数据。',INSTANCE_IDENTITY:'不同分子图保留独立身份；重复画出的结构不会按外观自动合并。',LABEL_ATTACHMENT:'本插件导出的分子编号随分子移动；编号单独调整的位置不保留。',PAGE_TRANSLATED:'导入路线移到现有内容下方，原有布局保留。',FROZEN_EXISTING_DRAFT:'现有自动初稿按当前坐标保存，避免导入时重新排列。',ARROW_WIDTH:'箭头起点保留，长度根据条件文字重新计算。',GENERATED_PLUS:'为缺少加号的反应补上分隔符。',OVERLAP:'部分展示区域重叠，请检查预览；导入后可继续调整。'}[warning.code]||warning.message||warning.code);
bind('cdxml-import',()=>{get('cdxml-file').value='';get('cdxml-file').click();});
get('cdxml-file').onchange=async()=>{
  const file=get('cdxml-file').files[0];if(!file||busy||dirty())return;
  busy=true;controls();clearImport();
  try{
    if(file.size>524288)throw Error('CDXML 文件不能超过 512 KiB。');
    const input={cdxml:await file.text(),expectedRevision:data.revision,operationId:crypto.randomUUID(),actor:'human'};
    const result=await api('/api/chemdraw/import',{...input,mode:'preview'});
    importCandidate={input,result};
    get('import-summary').textContent=`${file.name} · ${result.counts.molecules} 个分子，${result.counts.reactions} 个反应。确认后加入当前文档；现有内容保留。`;
    get('import-warnings').replaceChildren(...result.warnings.map(warning=>{const li=document.createElement('li');li.textContent=importWarningText(warning);return li;}));get('import-error').textContent='';
    importImageURL=URL.createObjectURL(new Blob([result.preview.svg],{type:'image/svg+xml'}));get('import-image').src=importImageURL;
    get('import-dialog').showModal();
  }catch(error){status.textContent=`导入预览失败：${error.message} 原文档未修改。`;}
  finally{busy=false;controls();}
};
bind('import-cancel',()=>{get('import-dialog').close();clearImport();});
get('import-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();else clearImport();});
bind('import-confirm',async()=>{
  if(!importCandidate)return;
  let result;
  try{
    result=await api('/api/chemdraw/import',{...importCandidate.input,mode:'commit'});
  }catch(error){get('import-error').textContent=`${error.message} 未确认成功；保留当前预览。版本冲突时请取消，重新读取文档后再预览。`;return;}
  get('import-dialog').close();clearImport();
  try{await refresh();status.textContent=`已导入 ${result.counts.molecules} 个分子、${result.counts.reactions} 个反应 · 文档 r${data.revision}。单分子可在研究画布查看；可撤销本次导入。`;}
  catch(error){status.textContent=`导入已提交到文档 r${result.currentRevision}，但画面刷新失败：${error.message}。请重新读取文档。`;}
});
const node=id=>paper.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
const element=id=>data.elements.find(item=>item.id===id);
const point=id=>moves.get(id)??element(id);
function move(id,x,y){x=Math.max(0,Math.round(x));y=Math.max(0,Math.round(y));const original=element(id);if(x===original.x&&y===original.y)moves.delete(id);else moves.set(id,{id,x,y});node(id).setAttribute('transform',`translate(${x} ${y})`);requestId=crypto.randomUUID();}
const local=event=>new DOMPoint(event.clientX,event.clientY).matrixTransform(paper.firstChild.getScreenCTM().inverse());
paper.onpointerdown=event=>{if(busy||drag||event.button!==0)return;const id=event.target.closest('[data-element-id]')?.dataset.elementId;if(!id)return;
  paper.focus({preventScroll:true});
  if(!event.shiftKey&&!selection.has(id))selection.clear();if(event.shiftKey&&selection.has(id))selection.delete(id);else selection.add(id);
  for(const item of data.elements)node(item.id).classList.toggle('chosen',selection.has(item.id));
  drag={start:local(event),points:[...selection].map(key=>({...point(key)})),before:snapshot(),pointerId:event.pointerId};paper.setPointerCapture(event.pointerId);message();};
paper.onpointermove=event=>{if(!drag||busy||event.pointerId!==drag.pointerId)return;const end=local(event);for(const p of translateSelection(drag.points,end.x-drag.start.x,end.y-drag.start.y))move(p.id,p.x,p.y);message();};
function finishDrag(cancel=false){if(!drag)return;const current=drag;drag=null;if(paper.hasPointerCapture(current.pointerId))paper.releasePointerCapture(current.pointerId);if(cancel)restore(current.before);else record(current.before);}
paper.onpointerup=event=>{if(event.pointerId===drag?.pointerId)finishDrag();};
paper.onlostpointercapture=paper.onpointercancel=()=>finishDrag(true);
bind('align',()=>{const before=snapshot();const top=Math.min(...[...selection].map(id=>point(id).y));for(const id of selection)move(id,point(id).x,top);record(before);});
bind('space',()=>{const before=snapshot();const items=[...selection].map(id=>({...element(id),...point(id)})).sort((a,b)=>a.x-b.x);const gap=Math.max(0,(items.at(-1).x+items.at(-1).width-items[0].x-items.reduce((sum,item)=>sum+item.width,0))/(items.length-1));let x=items[0].x;for(const item of items){move(item.id,x,item.y);x+=item.width+gap;}record(before);});
document.addEventListener('keydown',event=>{
  if(busy||!data||event.isComposing||document.querySelector('dialog[open]')||event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
  if(event.key==='Escape'&&drag){event.preventDefault();finishDrag(true);return;}
  if(drag||event.altKey)return;
  const key=event.key.toLowerCase();
  if(event.ctrlKey||event.metaKey){
    if(key==='z'||key==='y'){event.preventDefault();restore((key==='y'||event.shiftKey?history.redo:history.undo)(snapshot()));}
    return;
  }
  if(!selection.size||!paper.contains(document.activeElement))return;
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
  if(!delta)return;event.preventDefault();const before=snapshot(),step=event.shiftKey?10:1;
  for(const p of translateSelection([...selection].map(id=>({...point(id)})),delta[0]*step,delta[1]*step))move(p.id,p.x,p.y);
  record(before);
});
try{await refresh();}catch(error){status.textContent=error.message;controls();get('refresh').disabled=false;}

for (const link of document.querySelectorAll('a[href^="/"]')) {
  if (projectLocked && new URL(link.href).pathname === '/benchmark.html') link.remove();
  else link.href = workspacePageUrl(link.getAttribute('href'));
}

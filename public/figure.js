import {scopedFetch as request,workspacePageUrl} from './workspace-context.js';
import {readFigureSample} from './figure-sample.js';
import {figureReviews} from './figure-reviews.js';
const el=id=>document.getElementById(id);
const source=el('source');
let revision=null,savedSource='',stale=false,busy=false,blobUrl=null,shownSource=null,pendingId=null,sampleDraft=false;
let savedFigure=null;
const reviews=figureReviews({run,applyState:load,currentRevision:()=>revision,write:input=>api('/api/figure/review',input)});
const message=text=>{el('state').textContent=text;};
const dirty=()=>sampleDraft || source.value!==savedSource;
const available=()=>revision!==null && !busy;

for(const a of document.querySelectorAll('[data-project]'))a.href=workspacePageUrl(a.getAttribute('href'));
function controls(){
  source.disabled=!available();
  el('preview').disabled=!available() || !source.value.trim();
  el('save').disabled=!available() || !source.value.trim() || (!dirty() && !stale);
  el('download').disabled=!available() || dirty() || !savedSource || stale;
  el('reload').disabled=busy;
  reviews.update(savedFigure,Boolean(savedFigure && shownSource===savedSource && !dirty() && !stale),busy);
}
async function api(path,input){
  const response=await request(path,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const value=await response.json();
  if(!response.ok)throw Object.assign(Error(value.error?.message || response.statusText),{status:response.status});
  return value;
}
function clearImage(){
  el('paper').hidden=true;
  el('artwork').removeAttribute('src');el('artwork').hidden=true;el('empty').hidden=false;
  el('evidence').textContent='';shownSource=null;
  if(blobUrl)URL.revokeObjectURL(blobUrl);blobUrl=null;
}
function showImage(figure){
  clearImage();
  blobUrl=URL.createObjectURL(new Blob([figure.svg],{type:'image/svg+xml'}));
  el('artwork').src=blobUrl;el('artwork').hidden=false;el('empty').hidden=true;
  el('paper').hidden=false;
  const count=figure.molecules?.length || 0;
  const evidence=count?['已核验 '+count+' 个项目分子的结构记录。']:['自由 SVG，未绑定项目分子。'];
  const centers=(figure.molecules || []).flatMap(m=>m.coordinationCenters || []);
  if(centers.length){
    const explicit=centers.filter(c=>c.geometry && c.transPairs?.length).length;
    evidence.push('四配位和六配位金属中心中，'+explicit+'/'+centers.length+' 个有可读出的配位构型记录。');
  }
  if(figure.clippedSlotCount>0)evidence.push(figure.clippedSlotCount+' 个分子槽使用了 SVG 裁剪，部分结构可能被遮去。');
  if(figure.slotOverlays?.affectedSlots)evidence.push(figure.slotOverlays.rectangleCount+' 个后绘白色矩形与 '+figure.slotOverlays.affectedSlots+' 个分子槽相交。槽内含留白，请核对叠加处的标签和键线。');
  evidence.push('最终图面上的键、楔线及叠加图元需对照原图检查。');
  if(figure.textPreflight){
    const check=figure.textPreflight,findings=check.findings;
    evidence.push('已检查 '+check.measuredTextElements+'/'+check.textElements+' 个文字元素的 PNG 导出效果。');
    const labels=[...new Map(findings.map(f=>[f.index,f.text])).values()];
    if(labels.length){
      const outside=findings.filter(f=>f.kind==='text-outside-viewport').length;
      evidence.push('发现 '+outside+' 处文字越界、'+(findings.length-outside)+' 处行内字形交叠。涉及文字：'+labels.slice(0,3).map(s=>'「'+s.slice(0,36)+'」').join('、')+'。');
    }
    if(check.overlapChecksTruncated)evidence.push('行内片段交叠检查已达到计算上限。');
  }
  el('evidence').textContent=evidence.join('');
  shownSource=source.value;
}
async function load(state=undefined){
  state??=await api('/api/figure');
  revision=state.revision;savedFigure=state.figure;savedSource=state.figure?.source || '';source.value=savedSource;
  sampleDraft=false;pendingId=null;stale=Boolean(state.figure?.staleMoleculeIds.length);
  el('molecules').replaceChildren(...state.molecules.map(m=>{
    const li=document.createElement('li'),id=document.createElement('code');
    id.textContent=m.id;li.append(m.title+' · ',id);return li;
  }));
  clearImage();
  if(savedSource && !stale)showImage(await api('/api/figure/render?revision='+revision));
  message(stale?'关联分子已变化。预览后重新保存可更新图稿。':savedSource?'已读取图稿 · 项目 r'+revision:'当前项目尚无 SVG 图稿 · r'+revision);
}
function removeSampleParam(){
  const url=new URL(location.href);
  if(url.searchParams.has('sample')){
    url.searchParams.delete('sample');
    history.replaceState(null,'',url);
  }
}
async function openFigure(){
  await load();
  const runId=new URLSearchParams(location.search).get('sample');
  if(runId===null)return;
  const sample=await readFigureSample(runId);
  const preview=await api('/api/figure/preview',{source:sample.source});
  if(preview.sourceSha256!==sample.sourceSha256)throw Error('样例文件与评测归档校验值不符。');
  source.value=sample.source;sampleDraft=true;
  showImage(preview);
  message('评测样例 '+sample.caseId+' · 草稿未保存');
}
async function run(action){
  if(busy)return;
  busy=true;controls();
  try{await action();}catch(error){message(error.message);}finally{busy=false;controls();}
}
source.addEventListener('input',()=>{
  pendingId=null;
  if(shownSource!==source.value)clearImage();
  message(dirty()?'草稿未保存 · 项目 r'+revision:'已保存 · 项目 r'+revision);controls();
});
el('reload').onclick=()=>run(async()=>{
  if(!dirty() || confirm('重新读取会替换当前未保存的源码。继续吗？')){await load();removeSampleParam();}
});
el('preview').onclick=()=>run(async()=>{
  showImage(await api('/api/figure/preview',{source:source.value,checkText:true}));
  message(dirty()?'已预览 · 草稿未保存':'已预览 · 项目 r'+revision);
});
el('save').onclick=()=>run(async()=>{
  pendingId??=crypto.randomUUID();
  const result=await api('/api/figure/save',{source:source.value,expectedRevision:revision,operationId:pendingId,actor:'human'});
  revision=result.revision;savedFigure=result.figure;savedSource=result.figure.source;source.value=savedSource;stale=false;pendingId=null;sampleDraft=false;removeSampleParam();
  showImage(await api('/api/figure/render?revision='+revision));message('已保存 · 项目 r'+revision);
});
el('download').onclick=()=>run(async()=>{
  const response=await request('/api/figure/export?revision='+revision);
  if(!response.ok)throw Error((await response.json()).error?.message || response.statusText);
  const url=URL.createObjectURL(await response.blob());
  const a=document.createElement('a');a.download='figure.svg';a.href=url;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
});
window.addEventListener('beforeunload',event=>{if(dirty() || reviews.hasDraft()){event.preventDefault();event.returnValue='';}});
// Use the same project revision as the MCP tool. Never displace unsaved input.
let checking=false;
async function sync(){
  if(checking || busy || document.hidden || revision===null)return;
  const baseline=revision;
  checking=true;
  try{
    const response=await request('/api/figure?sinceRevision='+baseline);
    if(response.status===204 || !response.ok)return;
    const state=await response.json();
    if(busy || revision!==baseline)return;
    if(dirty())message('项目已更新至 r'+state.revision+'。本地草稿已保留，重新读取前可复制源码。');
    else await run(()=>load(state));
  }catch{/* The next visibility or timer check retries an interrupted read. */}
  finally{checking=false;}
}
window.addEventListener('focus',sync);
document.addEventListener('visibilitychange',sync);
setInterval(sync,4000);
run(openFigure);

import { createHash } from 'node:crypto';
import { applyOperation } from '../src/core/index.js';
import { failure } from './store.js';
import { figureRegionImage } from './canvas-overview.js';

export const figureFormat='chem-canvas.figure/1';

function savedFigure(document) {
  return Object.values(document.objects).find(object=>object.kind==='publication' && object.data.format===figureFormat);
}

function artworkKey(data) {
  // A molecule can be redrawn without changing the SVG slot in the source.
  return createHash('sha256').update(JSON.stringify([data.sourceSha256,Object.entries(data.versions).sort()])).digest('hex');
}

function description(document, object) {
  if(!object)return null;
  const {source,sourceSha256,molecules,versions}=object.data;
  const staleMoleculeIds=Object.keys(versions).filter(id=>document.objects[id]?.version!==versions[id]);
  const key=artworkKey(object.data);
  const reviewNotes=(object.data.reviewNotes ?? []).map(note=>({...note,onCurrentArtwork:!staleMoleculeIds.length && note.artworkKey===key}));
  return {id:object.id,version:object.version,source,sourceSha256,molecules,staleMoleculeIds,artworkKey:key,reviewNotes};
}

export function readFigure(document) {
  const molecules=Object.values(document.objects).filter(o=>o.kind==='molecule').map(({id,title,data})=>({id,title,smiles:data.smiles}));
  return {documentId:document.id,revision:document.revision,figure:description(document,savedFigure(document)),molecules};
}

export async function previewFigure(document,source,checkText=false,printWidthMm) {
  if(printWidthMm!==undefined && (!Number.isFinite(printWidthMm) || printWidthMm<=0)){
    throw failure('VALIDATION','printWidthMm must be a positive finite number of millimetres.');
  }
  const {renderFigureSvg}=await import('./figure-svg.js');
  const rendered=await renderFigureSvg(document,source);
  if(checkText===true || printWidthMm!==undefined){
    const {checkSvgText}=await import('./svg-text-preflight.js');
    rendered.textPreflight=checkSvgText(rendered.svg,{printWidthMm});
  }
  return {documentId:document.id,revision:document.revision,...rendered};
}

export async function saveFigure(store,input) {
  const result=await store.mutate('figure/save',input,async document=>{
    const figure=await previewFigure(document,input.source);
    const current=savedFigure(document);
    const versions=Object.fromEntries(figure.molecules.map(m=>[m.id,document.objects[m.id].version]));
    const data={format:figureFormat,source:input.source,sourceSha256:figure.sourceSha256,molecules:figure.molecules,versions,reviewNotes:current?.data.reviewNotes ?? []};
    const object=current?null:{id:'figure-'+createHash('sha256').update(input.operationId).digest('hex').slice(0,24),kind:'publication',title:'SVG 图稿',data};
    const change=current?{type:'updateObject',id:current.id,patch:{data}}:{type:'createObject',object};
    return applyOperation(document,{operationId:input.operationId,expectedRevision:input.expectedRevision,actor:input.actor??'human',intent:'保存 SVG 图稿',changes:[change]});
  });
  const figure=description(result.document,savedFigure(result.document));
  return {documentId:result.document.id,revision:result.document.revision,figure,molecules:figure?.molecules ?? [],replayed:Boolean(result.replayed)};
}

export async function reviewFigure(store,input) {
  const result=await store.mutate('figure/review',input,document=>{
    const current=savedFigure(document);
    if(!current || current.id!==input.figureId)throw failure('CONFLICT','图稿已变化，请重新读取。');
    const notes=current.data.reviewNotes ?? [];
    let reviewNotes,intent;
    if(input.action==='add'){
      const figure=description(document,current);
      if(figure.staleMoleculeIds.length || input.artworkKey!==figure.artworkKey)throw failure('CONFLICT','批注对应的图面已变化，请核对新版位置。');
      const text=typeof input.text==='string' ? input.text.trim() : '';
      if(!text || text.length>1000)throw failure('VALIDATION','批注须为 1 至 1000 个字符。');
      let point=null;
      if(input.point!=null){
        const {x,y}=input.point;
        if(![x,y].every(v=>Number.isFinite(v) && v>=0 && v<=1))throw failure('VALIDATION','批注位置须在图面内。');
        point={x,y};
      }
      let region;
      if(input.region!=null){
        const {x,y,width,height}=input.region;
        if(point || ![x,y,width,height].every(Number.isFinite) || x<0 || y<0 || width<=0 || height<=0 || x+width>1 || y+height>1)
          throw failure('VALIDATION','框选须为图面内有面积的矩形，并且只能选择一种批注位置。');
        region={x,y,width,height};
      }
      reviewNotes=[...notes,{id:input.operationId,text,point,...(region && {region}),artworkKey:figure.artworkKey,createdAtRevision:document.revision+1,resolvedAtRevision:null}];
      intent='添加图稿批注';
    }else if(input.action==='resolve'){
      const note=notes.find(n=>n.id===input.noteId);
      if(!note)throw failure('NOT_FOUND','找不到该条批注。');
      if(note.resolvedAtRevision!=null)throw failure('CONFLICT','该条批注已核对。');
      reviewNotes=notes.map(n=>n===note?{...n,resolvedAtRevision:document.revision+1}:n);
      intent='核对图稿批注';
    }else throw failure('VALIDATION','无效的批注操作。');
    return applyOperation(document,{operationId:input.operationId,expectedRevision:input.expectedRevision,actor:'human',intent,
      changes:[{type:'updateObject',id:current.id,patch:{data:{...current.data,reviewNotes}}}]});
  });
  return {...readFigure(result.document),replayed:Boolean(result.replayed)};
}

export function renderSavedFigure(document,revision) {
  if(revision!==String(document.revision))throw failure('CONFLICT','项目已变化，请重新读取图稿并确认导出版本。');
  const figure=description(document,savedFigure(document));
  if(!figure)throw failure('NOT_FOUND','请先保存 SVG 图稿。');
  if(figure.staleMoleculeIds.length)throw failure('CONFLICT','关联分子已变化，请重新预览并保存图稿。');
  return previewFigure(document,figure.source);
}

// Use the saved molecular records from each revision when expanding its SVG slots.
export async function compareFigureRegion(document, revision, noteId, includeImages = true) {
  if (String(document.revision) !== revision) throw failure('CONFLICT','项目已变化，请重新读取图稿。');
  const current = description(document, savedFigure(document));
  const note = current?.reviewNotes.find(item => item.id === noteId);
  if (!note) throw failure('NOT_FOUND','找不到指定的图稿批注。');
  if (!note.region) throw failure('VALIDATION','这条批注没有选框。');
  if (current.staleMoleculeIds.length) throw failure('CONFLICT','关联分子已变化，请重新预览并保存图稿。');

  const entry = document.history.find(item => item.revision === note.createdAtRevision && item.operationId === note.id);
  if (!entry?.after) throw failure('CONFLICT','缺少批注所在版本的图稿。');
  const originalDocument = {id:document.id, revision:entry.revision, objects:entry.after.objects};
  const original = description(originalDocument, savedFigure(originalDocument));
  if (original?.id !== current.id || original.artworkKey !== note.artworkKey || original.staleMoleculeIds.length) {
    throw failure('CONFLICT','批注与历史图稿不匹配。');
  }
  const comparison = {basis:'same-relative-region', region:note.region};
  const images = [];
  for (const [role, snapshot, figure] of [['original', originalDocument, original], ['current', document, current]]) {
    const frame = {revision:snapshot.revision, artworkKey:figure.artworkKey, sourceSha256:figure.sourceSha256};
    if (includeImages) {
      const rendered = await previewFigure(snapshot, figure.source);
      const crop = figureRegionImage(rendered, note);
      frame.image = crop.metadata;
      images.push(crop.content);
    }
    comparison[role] = frame;
  }
  return {comparison, images};
}

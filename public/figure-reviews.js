import {projectId} from './workspace-context.js';
import {bindRegionSelection} from './figure-region.js';
import {figureReviewRequest} from './figure-review-request.js';

const el=id=>document.getElementById(id);
const percent=n=>Math.round(n*100)+'%';
const position=(point,region)=>region?'选框（'+percent(region.x)+'，'+percent(region.y)+'）至（'+percent(region.x+region.width)+'，'+percent(region.y+region.height)+'）':point?'左起 '+percent(point.x)+'，上起 '+percent(point.y):'整张图';
const bounded=n=>Math.min(1,Math.max(0,n));

export function figureReviews({write,compare,run,applyState,currentRevision}){
  const field=el('review-text'),pick=el('pick-point'),reset=el('review-reset');
  let figure=null,visible=false,busy=true,point=null,region=null,draftKey=null,pending=null,copySequence=0;
  const area=bindRegionSelection(pick,{onChange(){pins();controls();},onSelect(rect){choose(null,rect);field.focus();}});
  const outdated=()=>draftKey!==null && draftKey!==figure?.artworkKey;
  const hasDraft=()=>Boolean(field.value.trim() || point || region || area.first);
  function controls(){
    const active=visible && !busy;
    pick.disabled=!active;
    el('paper').classList.toggle('selecting-region',area.active);
    const toggle=el('review-region');
    toggle.disabled=!active;toggle.setAttribute('aria-pressed',String(area.active));
    toggle.textContent=area.active?'取消框选':'框选区域';
    field.disabled=busy || (!visible && !hasDraft());
    el('review-add').disabled=!active || area.active || outdated() || !field.value.trim();
    reset.hidden=(!point && !region && !outdated()) || area.active;
    reset.disabled=!active;
    reset.textContent=outdated()?'将意见用于当前图稿':'清除位置';
    el('review-context').textContent=area.active?(area.first?'选择对角完成框选。方向键可微调，回车确认。':'拖出方框，或依次点两个对角。键盘可用方向键和回车。')
      :outdated()?'图稿已更新。原意见已保留，请在新版重新定位或确认用于整张图。'
      :!visible?'保存图稿并显示当前预览后可以添加批注。'
      :point || region?'批注位置 · '+position(point,region)+'。'
      :'点击图面指定位置，或直接填写整张图的意见。';
    for(const btn of el('reviews').querySelectorAll('button'))btn.disabled=!active;
    const open=figure?.reviewNotes?.some(note=>!note.resolvedAtRevision);
    el('review-copy').hidden=!open;
    el('review-copy').disabled=!active;
  }
  function pin(label,where,draft){
    const marker=document.createElement(draft?'span':'button');
    marker.className=draft?'pin draft':'pin';
    marker.textContent=label;
    marker.style.left=percentExact(where.x);marker.style.top=percentExact(where.y);
    if(!draft){
      marker.type='button';marker.setAttribute('aria-label','查看批注 '+label);
      marker.onclick=()=>el('review-note-'+label).focus();
    }
    return marker;
  }
  const percentExact=n=>(100*n)+'%';
  function box(rect,draft){
    const outline=document.createElement('span');outline.className=draft?'region-box draft':'region-box';
    Object.assign(outline.style,{left:percentExact(rect.x),top:percentExact(rect.y),width:percentExact(rect.width),height:percentExact(rect.height)});
    return outline;
  }
  function pins(){
    const markers=[];
    if(visible){
      (figure?.reviewNotes ?? []).forEach((note,i)=>{
        if(!note.onCurrentArtwork || note.resolvedAtRevision)return;
        if(note.region)markers.push(box(note.region,false));
        const where=note.region ?? note.point;
        if(where)markers.push(pin(String(i+1),where,false));
      });
      if(area.active){
        const rect=area.rectangle();if(rect?.width && rect.height)markers.push(box(rect,true));
        if(area.cursor)markers.push(pin('+',area.cursor,true));
      }else if(!outdated()){
        if(region)markers.push(box(region,true));
        if(point || region)markers.push(pin('+',point ?? region,true));
      }
    }
    el('pins').replaceChildren(...markers);
  }
  function appendComparison(row,note,index){
    const toggle=document.createElement('button'),panel=document.createElement('div');
    toggle.type='button';toggle.textContent='对照修改前后';toggle.setAttribute('aria-expanded','false');
    panel.className='review-comparison';panel.id='review-comparison-'+index;panel.hidden=true;
    toggle.setAttribute('aria-controls',panel.id);
    toggle.onclick=()=>run(async()=>{
      if(panel.hidden && !panel.childElementCount){
        const {comparison,images}=await compare(note.id);
        for(const [i,role] of ['original','current'].entries()){
          const frame=comparison[role],item=document.createElement('figure'),caption=document.createElement('figcaption'),img=document.createElement('img');
          caption.textContent=(i===0?'批注时':'当前图稿')+' · r'+frame.revision;
          img.src='data:image/png;base64,'+images[i].data;img.alt=caption.textContent+'的选区';
          img.width=frame.image.width*3;
          item.append(caption,img);panel.append(item);
        }
        const hint=document.createElement('small');hint.textContent='两图取自相同的相对位置。若排版有移动，请核对选框中的内容。';
        panel.append(hint);
      }
      panel.hidden=!panel.hidden;
      toggle.setAttribute('aria-expanded',String(!panel.hidden));
    });
    row.append(toggle,panel);
  }
  function list(){
    copySequence++;
    el('review-request').hidden=true;
    if(el('review-status').textContent.startsWith('正在复制'))el('review-status').textContent='';
    const open=figure?.reviewNotes.filter(note=>!note.resolvedAtRevision) ?? [];
    el('review-copy').textContent=open.length>1?'复制全部 '+open.length+' 条给 Agent':'复制这条给 Agent';
    const rows=(figure?.reviewNotes ?? []).map((note,i)=>{
      const li=document.createElement('li'),body=document.createElement('p'),meta=document.createElement('small');
      li.id='review-note-'+(i+1);li.tabIndex=-1;
      body.textContent=note.text;
      meta.textContent=[note.resolvedAtRevision?'已核对':'待核对',note.onCurrentArtwork?'当前图稿':'旧版位置','r'+note.createdAtRevision,position(note.point,note.region)].join(' · ');
      li.append(body,meta);
      if(!note.resolvedAtRevision){
        if(open.length>1){
          const copy=document.createElement('button');
          copy.type='button';copy.textContent='复制这条给 Agent';
          copy.setAttribute('aria-label','复制批注 '+(i+1)+' 给 Agent');
          copy.onclick=()=>copyRequest([note]);
          li.append(copy);
        }
        const btn=document.createElement('button');btn.type='button';btn.textContent='标为已核对';
        btn.onclick=()=>run(async()=>{
          const state=await write({action:'resolve',operationId:crypto.randomUUID(),expectedRevision:currentRevision(),figureId:figure.id,noteId:note.id});
          await applyState(state);el('review-status').textContent='已核对批注 '+(i+1)+'。';
        });
        li.append(btn);
      }
      if(note.region && !note.onCurrentArtwork)appendComparison(li,note,i+1);
      return li;
    });
    el('reviews').replaceChildren(...rows);
  }
  function choose(where,rect=null){
    point=where;region=rect;draftKey=hasDraft()?figure.artworkKey:null;pending=null;
    el('review-status').textContent='';pins();controls();
  }
  reset.onclick=()=>choose(null);
  el('review-region').onclick=()=>area.active?area.cancel():area.start();
  async function copyRequest(notes){
    const sequence=++copySequence;
    const request=figureReviewRequest(projectId,figure.id,notes);
    const output=el('review-request');
    const target=notes.length===1?'批注 '+(figure.reviewNotes.indexOf(notes[0])+1):'全部 '+notes.length+' 条批注';
    const status=el('review-status');
    output.hidden=true;
    status.textContent='正在复制'+target+'…';
    try{
      await navigator.clipboard.writeText(request);
      if(sequence===copySequence)status.textContent='已复制'+target+'，可粘贴到 Agent 对话。';
    }catch{
      if(sequence!==copySequence)return;
      output.value=request;output.hidden=false;output.focus();output.select();
      status.textContent='请手动复制'+target+'的请求，粘贴到 Agent 对话。';
    }
  }
  el('review-copy').onclick=()=>copyRequest(figure.reviewNotes.filter(note=>!note.resolvedAtRevision));
  const keyboardPoint=()=>outdated() || !point?{x:.5,y:.5}:point;
  pick.onclick=event=>{
    if(area.click(event))return;
    const box=pick.getBoundingClientRect();
    choose(event.detail===0?keyboardPoint():{x:bounded((event.clientX-box.left)/box.width),y:bounded((event.clientY-box.top)/box.height)});
    field.focus();
  };
  pick.onkeydown=event=>{
    if(area.key(event))return;
    const offsets={ArrowLeft:[-.01,0],ArrowRight:[.01,0],ArrowUp:[0,-.01],ArrowDown:[0,.01]};
    const offset=offsets[event.key];if(!offset)return;
    event.preventDefault();
    const here=keyboardPoint();
    choose({x:bounded(here.x+offset[0]),y:bounded(here.y+offset[1])});
  };
  field.oninput=()=>{
    if(!hasDraft())draftKey=null;
    else draftKey??=figure?.artworkKey;
    pending=null;el('review-status').textContent='';controls();
  };
  el('review-form').onsubmit=event=>{
    event.preventDefault();
    if(el('review-add').disabled)return;
    run(async()=>{
      pending??={action:'add',operationId:crypto.randomUUID(),expectedRevision:currentRevision(),figureId:figure.id,artworkKey:figure.artworkKey,text:field.value.trim(),point,...(region && {region})};
      let state;
      try{state=await write(pending);}
      catch(error){if(error.status>=400 && error.status<500)pending=null;throw error;}
      field.value='';point=null;region=null;draftKey=null;pending=null;
      await applyState(state);el('review-status').textContent='批注已保存。Agent 读取这个项目的图稿时可见。';
    });
  };
  return {hasDraft,update(next,canMark,isBusy){
    const changed=figure!==next,visibilityChanged=visible!==canMark;
    const cancel=area.active && (!canMark || (figure?.artworkKey!==next?.artworkKey));
    figure=next;visible=canMark;busy=isBusy;
    if(cancel)area.cancel();
    if(pending && figure?.reviewNotes?.some(n=>n.id===pending.operationId)){
      field.value='';point=null;region=null;draftKey=null;pending=null;
      el('review-status').textContent='批注已保存。Agent 读取这个项目的图稿时可见。';
    }
    if(changed)list();
    if(changed || visibilityChanged)pins();
    controls();
  }};
}


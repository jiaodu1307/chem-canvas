// Positions are fractions of each full image. Letterboxing and zoom never stretch chemical structures.
export function imageLayout(width, height, imageWidth, imageHeight, zoom, center) {
  const fit = Math.min(width / imageWidth, height / imageHeight) * zoom;
  const w = imageWidth * fit;
  const h = imageHeight * fit;
  return {width:w, height:h, left:width / 2 - center.x * w, top:height / 2 - center.y * h};
}
const clamp = value => Math.min(1,Math.max(0,value));
export function moveCenter(center, dx, dy, layout) {
  return {x:clamp(center.x-dx/layout.width),y:clamp(center.y-dy/layout.height)};
}

export function imagePoint(layout, x, y) {
  const u=(x-layout.left)/layout.width, v=(y-layout.top)/layout.height;
  if(!(u>=0 && u<=1 && v>=0 && v<=1))return null;
  return {x:u,y:v};
}

export function imageRectangle(a,b) {
  const width=Math.abs(b.x-a.x),height=Math.abs(b.y-a.y);
  return width && height ? {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width,height} : null;
}

function t(zh,en){
  return document.documentElement.lang==='en'?en:zh;
}
function syncLanguageLink(){
  const link=document.querySelector('[data-language]');
  if(link)link.hash=location.hash;
}
function setupCatalog(catalog) {
  const search=catalog.querySelector('[data-query]'), links=[...catalog.querySelectorAll('[data-case-link]')];
  const filters=[...catalog.querySelectorAll('[data-filter]')];
  function filter() {
    const active=filters.find(link=>link.hash===location.hash)?.dataset.filter??'catalog';
    const mode=active==='data-only'?'from-data':active;
    const query=search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    let count=0;
    for(const link of links) {
      const matches=mode==='catalog' || link.dataset.protocols.split(' ').includes(mode);
      link.hidden=!matches || !query.every(q=>link.dataset.search.toLocaleLowerCase().includes(q));
      if(!link.hidden)count++;
      link.hash=mode==='catalog'?'':mode;
    }
    for(const link of filters){
      if(link.dataset.filter===active)link.setAttribute('aria-current','true');
      else link.removeAttribute('aria-current');
    }
    catalog.querySelector('[data-found]').textContent=query.length ? count?t('找到 '+count+' 个案例',count+(count===1?' case found':' cases found')):t('没有找到匹配的案例。试试作者姓氏或图表类型。','No matches. Try an author’s surname or a figure type.') :'';
    syncLanguageLink();
  }
  for(const link of filters)link.addEventListener('click',event=>{
    if(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
    event.preventDefault();
    if(location.hash!==link.hash)history.pushState(null,'',link.hash);
    filter();
  });
  window.addEventListener('hashchange',filter);
  search.addEventListener('input',filter);
  for(const item of catalog.querySelectorAll('[data-catalog-controls]'))item.hidden=false;
  filter();
}

function setup(group) {
  const query = selector => group.querySelector(selector);
  const picker=query('[data-version]'),paper=query('[data-paper]');
  const options=[...picker.options],routeButtons=[...group.querySelectorAll('[data-route]')],lastVersion=new Map();
  const stage=query('.stage'), image=stage.querySelector('img'), zoomSelect=query('[data-zoom]');
  const fullSize=query('[data-original]'),permalink=query('[data-permalink]');
  const panel=query('.feedback'), pin=query('.feedback-pin'), rectMarker=query('.feedback-rect'),note=query('[data-note]');
  const pick=query('[data-pick]'), rectButton=query('[data-rect]'),whole=query('[data-whole]'), copy=query('[data-copy]');
  const place=query('[data-feedback-place]'), status=query('[data-feedback-status]'), manual=query('[data-manual]');
  const drafts=new Map();
  let isPaper=false, center={x:0.5,y:0.5}, drag=null, layout;
  let targetKey='', point=null,area=null,picking=null,corner=null,cursor=null;
  function clearMessage() {
    status.textContent=''; manual.hidden=true; manual.value='';
  }
  function showFeedback() {
    place.textContent=area?t('已框选区域','Area selected'):point?t('左起 ','From left ')+(100*point.x).toFixed(1)+'% · '+t('上起 ','from top ')+(100*point.y).toFixed(1)+'%':t('整张图','Whole figure');
    pick.setAttribute('aria-pressed',String(picking==='point'));
    pick.textContent=picking==='point'?t('取消点选','Cancel point'):point?t('重选位置','Change point'):t('点选位置','Pick a point');
    rectButton.setAttribute('aria-pressed',String(picking==='rect'));
    rectButton.textContent=picking==='rect'?t('取消框选','Cancel selection'):area?t('重新框选','Change area'):t('框选区域','Select an area');
    whole.hidden=!point && !area;
    copy.disabled=!!picking || !note.value.trim();
    stage.classList.toggle('picking',!!picking);
    pin.hidden=!panel.open || !point;
    if(!pin.hidden && layout){
      pin.style.left=(layout.left+point.x*layout.width)+'px';
      pin.style.top=(layout.top+point.y*layout.height)+'px';
    }
    const box=corner&&cursor?imageRectangle(corner,cursor):area;
    rectMarker.hidden=!panel.open || !box || !layout;
    if(!rectMarker.hidden){
      rectMarker.style.left=(layout.left+box.x*layout.width)+'px';
      rectMarker.style.top=(layout.top+box.y*layout.height)+'px';
      rectMarker.style.width=box.width*layout.width+'px';
      rectMarker.style.height=box.height*layout.height+'px';
    }
    if(picking==='rect' && (corner || cursor) && layout){
      const p=cursor??corner;
      pin.hidden=false;pin.style.left=(layout.left+p.x*layout.width)+'px';pin.style.top=(layout.top+p.y*layout.height)+'px';
    }
  }
  function switchFeedback(key) {
    if(key===targetKey)return;
    if(targetKey && (point || area || note.value))drafts.set(targetKey,{point,area,text:note.value});
    else drafts.delete(targetKey);
    const saved=drafts.get(key);
    targetKey=key; point=saved?.point??null;area=saved?.area??null;note.value=saved?.text??'';
    drag=null;picking=null;corner=null;cursor=null;clearMessage();
  }
  function requestText() {
    const version=picker.selectedOptions[0], file=isPaper?paper.dataset.src:version.dataset.src;
    const asset=new URL(file,document.baseURI);
    const source=['http:','https:'].includes(asset.protocol)?asset.href:file;
    return [
      t('Chem Canvas 绘图反馈 · ','Chem Canvas figure feedback · ')+document.querySelector('h1').textContent+' ('+group.dataset.case+')',
      t('路线：','Protocol: ')+group.querySelector('h2').textContent+' / '+version.textContent,
      t('图稿：','Version: ')+(isPaper?t('论文原图','Paper figure'):t('成图','Agent drawing'))+' · '+version.dataset.anchor,
      t('图片：','Image: ')+source,
      area?t('区域：','Area: ')+Object.entries(area).map(([k,v])=>k+'='+v.toFixed(4)).join(', ')+
        t('（整图左上角为原点，右下角 x=',' (origin at top left, bottom right x=')+(area.x+area.width).toFixed(4)+', y='+(area.y+area.height).toFixed(4)+t('）',')'):
        point?t('位置：','Point: ')+`x=${point.x.toFixed(4)}, y=${point.y.toFixed(4)}`+t('（左上角为 0,0；右下角为 1,1）',' (top left 0,0; bottom right 1,1)'):t('位置：整张图','Area: whole figure'),
      t('修改意见：','Revision: ')+note.value.trim(),
    ].join('\n');
  }
  function choosePoint(x,y) {
    const chosen=imagePoint(layout,x,y);
    if(!chosen){status.textContent=t('请点在图片内。','Choose a point inside the image.');return;}
    point=chosen;area=null;picking=null;clearMessage();showFeedback();
  }
  function startPick(mode) {
    picking=picking===mode?null:mode;corner=null;cursor=null;clearMessage();showFeedback();
    if(picking){
      status.textContent=mode==='rect'?t('拖出矩形或轻点两个对角。键盘可用方向键移动，按 Enter 确认角点。','Drag a rectangle or tap its opposite corners. Use arrow keys to move and Enter to confirm a corner.'):t('轻点图片，或按 Enter 标记视图中心。','Tap the image or press Enter to mark the center.');
      stage.focus({preventScroll:true}); stage.scrollIntoView({block:'center'});
    }
  }
  function chooseCorner(p) {
    if(!p){status.textContent=t('请点在图片内。','Choose a point inside the image.');return;}
    if(!corner){corner=p;cursor=p;status.textContent=t('已选第一个角，请选另一个对角。','First corner set. Select the opposite corner.');}
    else{
      const rect=imageRectangle(corner,p);
      if(!rect){status.textContent=t('请选一个能构成矩形的对角。','Choose an opposite corner to form a rectangle.');return;}
      area=rect;point=null;corner=null;cursor=null;picking=null;clearMessage();
    }
    showFeedback();
  }
  pick.addEventListener('click',()=>startPick('point'));
  rectButton.addEventListener('click',()=>startPick('rect'));
  whole.addEventListener('click',()=>{point=null;area=null;picking=null;corner=null;cursor=null;clearMessage();showFeedback();});
  panel.addEventListener('toggle',()=>{if(!panel.open){picking=null;corner=null;cursor=null;clearMessage();}showFeedback();});
  note.addEventListener('input',()=>{clearMessage();showFeedback();});
  copy.addEventListener('click',async()=>{
    if(copy.disabled)return;
    const key=targetKey,text=requestText();
    const current=()=>panel.open && key===targetKey && text===requestText();
    try{
      await navigator.clipboard.writeText(text);
      if(current()){clearMessage();status.textContent=t('已复制，可粘贴到 Agent 对话。','Copied. Paste the note into your agent chat.');}
    }catch{
      if(!current())return;
      manual.value=text;manual.hidden=false;manual.focus();manual.select();
      status.textContent=t('请手动复制下方文字。','Copy the text below.');
    }
  });
  function paint() {
    const version=picker.selectedOptions[0];
    const data=isPaper?paper.dataset:version.dataset;
    const zoom=Number(zoomSelect.value);
    const w=Number(data.width), h=Number(data.height);
    if(!stage.clientWidth || !stage.clientHeight)return;
    layout=imageLayout(stage.clientWidth,stage.clientHeight,w,h,zoom,center);
    switchFeedback(version.dataset.anchor+'|'+(isPaper?'paper':'drawing')+'|'+data.src);
    showFeedback();
    if(image.getAttribute('src')!==data.src)image.src=data.src;
    image.alt=isPaper?t('论文原图','Paper figure'):version.textContent;
    image.style.width=layout.width+'px';
    image.style.height=layout.height+'px';
    image.style.transform='translate('+layout.left+'px,'+layout.top+'px)';
    fullSize.href=data.src;
    fullSize.setAttribute('aria-label',t('查看大图 · ','Full-size image · ')+image.alt);
    stage.classList.toggle('zoomed',zoom>1);
    paper?.setAttribute('aria-pressed',String(isPaper));
    if(routeButtons.length)for(const btn of routeButtons){
      const active=btn.dataset.route===version.dataset.method;
      btn.toggleAttribute('data-drawing',active);
      btn.setAttribute('aria-pressed',String(active && !isPaper));
    }
    else query('[data-drawing]')?.setAttribute('aria-pressed',String(!isPaper));
  }
  function selectVersion(option=picker.selectedOptions[0]) {
    if(routeButtons.length){
      const method=option.dataset.method;
      if(picker.dataset.method!==method){
        picker.replaceChildren(...options.filter(o=>o.dataset.method===method));
        picker.dataset.method=method;
      }
      lastVersion.set(method,option);
    }
    picker.value=option.value;
    for(const panel of group.querySelectorAll('[data-score]'))panel.hidden=panel.dataset.score!==picker.value;
    permalink.href='#'+picker.selectedOptions[0].dataset.anchor;
    isPaper=false;
    paint();
  }
  function openLinkedVersion(){
    const linked=options.find(option=>'#'+option.dataset.anchor===location.hash);
    if(linked || !layout)selectVersion(linked??picker.selectedOptions[0]);
  }
  function reset(){
    zoomSelect.value='1';
    center={x:.5,y:.5};
    paint();
  }
  paper?.addEventListener('click',()=>{isPaper=true;paint();});
  query('[data-drawing]')?.addEventListener('click',()=>{isPaper=false;paint();});
  for(const button of routeButtons){
    button.addEventListener('click',()=>{
      const method=button.dataset.route;
      selectVersion(lastVersion.get(method)??options.find(o=>o.dataset.method===method));
      history.replaceState(null,'',permalink.hash);
      syncLanguageLink();
    });
  }
  picker.addEventListener('change',()=>{
    selectVersion();
    history.replaceState(null,'',permalink.hash);
    syncLanguageLink();
  });
  window.addEventListener('hashchange',openLinkedVersion);
  zoomSelect.addEventListener('change',()=>{
    if(zoomSelect.value==='1')reset();else paint();
  });
  query('[data-reset]').addEventListener('click',reset);
  function eventPoint(event,clip=false) {
    const bounds=stage.getBoundingClientRect();
    const x=event.clientX-bounds.left-stage.clientLeft,y=event.clientY-bounds.top-stage.clientTop;
    return clip?{x:clamp((x-layout.left)/layout.width),y:clamp((y-layout.top)/layout.height)}:imagePoint(layout,x,y);
  }
  stage.addEventListener('pointerdown',event=>{
    if((!picking && zoomSelect.value==='1') || !event.isPrimary || event.button!==0)return;
    stage.setPointerCapture(event.pointerId);
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,origin:eventPoint(event),priorCorner:corner};
  });
  stage.addEventListener('pointermove',event=>{
    if(!drag || drag.id!==event.pointerId || !layout)return;
    if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>5)drag.moved=true;
    if(picking==='rect'){
      if(drag.moved && drag.origin){corner??=drag.origin;cursor=eventPoint(event,true);showFeedback();}
      return;
    }
    if(zoomSelect.value==='1' || (picking && !drag.moved))return;
    center=moveCenter(center,event.clientX-drag.x,event.clientY-drag.y,layout);
    drag.x=event.clientX; drag.y=event.clientY;
    paint();
  });
  stage.addEventListener('pointerup',event=>{
    if(!drag || drag.id!==event.pointerId)return;
    if(picking==='rect'){
      if(drag.moved && !drag.origin)status.textContent=t('请从图片内开始框选。','Start the selection inside the image.');
      else chooseCorner(eventPoint(event,drag.moved));
    }else if(picking && !drag.moved && Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<=5){
      const rect=stage.getBoundingClientRect();
      choosePoint(event.clientX-rect.left-stage.clientLeft,event.clientY-rect.top-stage.clientTop);
    }
    drag=null;
  });
  stage.addEventListener('lostpointercapture',()=>{
    if(drag && picking==='rect'){corner=drag.priorCorner;cursor=corner;showFeedback();}
    drag=null;
  });
  stage.addEventListener('keydown',event=>{
    const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(picking==='rect' && (arrows[event.key] || event.key==='Enter')){
      event.preventDefault();
      cursor??={...center};
      if(event.key==='Enter')chooseCorner(cursor);
      else{
        const [dx,dy]=arrows[event.key];cursor={x:clamp(cursor.x+dx*.01),y:clamp(cursor.y+dy*.01)};showFeedback();
      }
      return;
    }
    if(picking==='point' && event.key==='Enter'){event.preventDefault();choosePoint(stage.clientWidth/2,stage.clientHeight/2);return;}
    if(picking && event.key==='Escape'){const button=picking==='rect'?rectButton:pick;picking=null;corner=null;cursor=null;clearMessage();showFeedback();button.focus();return;}
    if(event.key==='Home'){event.preventDefault();reset();return;}
    if(zoomSelect.value==='1' || !layout)return;
    const delta={ArrowLeft:[32,0],ArrowRight:[-32,0],ArrowUp:[0,32],ArrowDown:[0,-32]}[event.key];
    if(!delta)return;
    event.preventDefault();
    center=moveCenter(center,...delta,layout);
    paint();
  });
  stage.classList.add('active');
  for(const controls of group.querySelectorAll('[data-controls]'))controls.hidden=false;
  if(typeof ResizeObserver==='function')new ResizeObserver(paint).observe(stage);
  else window.addEventListener('resize',paint);
  openLinkedVersion();
}
if(typeof document!=='undefined'){
  syncLanguageLink();
  window.addEventListener('hashchange',syncLanguageLink);
  document.querySelectorAll('[data-comparison]').forEach(setup);
  document.querySelectorAll('[data-catalog]').forEach(setupCatalog);
}

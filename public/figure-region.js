// Coordinates are relative to the displayed artwork, excluding the surrounding sheet.
export function bindRegionSelection(surface,{onChange,onSelect}){
  let active=false,first=null,cursor=null,gesture=null,consumeClick=false;
  const bound=n=>Math.min(1,Math.max(0,n));
  function pointer(event){
    const box=surface.getBoundingClientRect();
    return {x:bound((event.clientX-box.left)/box.width),y:bound((event.clientY-box.top)/box.height)};
  }
  function rectangle(){
    if(!first || !cursor)return null;
    return {x:Math.min(first.x,cursor.x),y:Math.min(first.y,cursor.y),width:Math.abs(first.x-cursor.x),height:Math.abs(first.y-cursor.y)};
  }
  function stop(){
    const id=gesture?.id;
    gesture=null;active=false;first=null;cursor=null;
    if(id!==undefined && surface.hasPointerCapture(id))surface.releasePointerCapture(id);
  }
  function finish(){
    const area=rectangle();
    if(area?.width>0 && area.height>0){stop();onSelect(area);}
    else onChange();
  }
  surface.addEventListener('pointerdown',event=>{
    if(!event.isPrimary || event.button!==0)return;
    consumeClick=active;
    if(!active)return;
    event.preventDefault();
    const start=pointer(event);
    gesture={id:event.pointerId,second:Boolean(first),startX:event.clientX,startY:event.clientY};
    first??=start;cursor=start;
    surface.setPointerCapture(event.pointerId);onChange();
  });
  surface.addEventListener('pointermove',event=>{
    if(!active || !first || !event.isPrimary || (gesture && gesture.id!==event.pointerId))return;
    cursor=pointer(event);onChange();
  });
  surface.addEventListener('pointerup',event=>{
    if(!gesture || gesture.id!==event.pointerId)return;
    const complete=gesture.second || Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)>4;
    cursor=pointer(event);gesture=null;surface.releasePointerCapture(event.pointerId);
    if(complete)finish();else onChange();
  });
  function cancelGesture(event){
    if(gesture?.id!==event.pointerId)return;
    stop();onChange();
  }
  surface.addEventListener('pointercancel',cancelGesture);
  surface.addEventListener('lostpointercapture',cancelGesture);
  return {
    get active(){return active;},get first(){return first;},get cursor(){return cursor;},rectangle,
    start(){active=true;first=null;cursor={x:.5,y:.5};consumeClick=false;surface.focus({preventScroll:true});surface.scrollIntoView({block:'nearest'});onChange();},
    cancel(){stop();onChange();},
    click(event){
      if(active && event.detail===0){
        if(first)finish();else{first={...cursor};onChange();}
        return true;
      }
      const handled=active || (consumeClick && event.detail>0);
      consumeClick=false;return handled;
    },
    key(event){
      if(!active)return false;
      if(event.key==='Escape'){event.preventDefault();stop();onChange();return true;}
      const dir={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(!dir)return false;
      event.preventDefault();const step=event.shiftKey ? .1 : .01;
      cursor={x:bound(cursor.x+dir[0]*step),y:bound(cursor.y+dir[1]*step)};onChange();return true;
    },
  };
}

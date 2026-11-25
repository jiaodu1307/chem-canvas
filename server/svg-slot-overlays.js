// Geometry of authored rectangles only. The slot includes whitespace in its native depiction.
const identity = {sx:1, sy:1, tx:0, ty:0};
const opaque = value => value === undefined || Number(value) === 1 || /^100(?:\.0*)?%$/.test(value);
const white = value => /^(?:white|#fff|#ffff|#ffffff|#ffffffff|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i.test(value);

function transformed(parent, value) {
  if (!value) return parent;
  let {sx,sy,tx,ty} = parent;
  for (const [,name,args] of value.matchAll(/(\w+)\(([^()]*)\)/g)) {
    const a = args.trim().split(/[\s,]+/).map(Number);
    if (name === 'translate' && [1,2].includes(a.length)) {
      tx += sx*a[0]; ty += sy*(a[1] ?? 0);
    } else if (name === 'scale' && [1,2].includes(a.length)) {
      sx *= a[0]; sy *= a[1] ?? a[0];
    } else if (name === 'matrix' && a.length === 6 && a[1] === 0 && a[2] === 0) {
      tx += sx*a[4]; ty += sy*a[5];
      sx *= a[0]; sy *= a[3];
    } else return null;
  }
  return [sx,sy,tx,ty].every(Number.isFinite) && sx && sy ? {sx,sy,tx,ty} : null;
}

function inherit(value, fallback) {
  return value === undefined || value.toLowerCase() === 'inherit' ? fallback : value;
}

export function slotPaintContext(parent, name, attrs, isRoot) {
  if ((isRoot ? name !== 'svg' : !parent || !['g','rect'].includes(name)) ||
      (attrs['clip-path'] && attrs['clip-path'] !== 'none') || !opaque(attrs.opacity)) return null;
  const transform = transformed(parent?.transform ?? identity, attrs.transform);
  if (!transform) return null;
  return {transform, fill:inherit(attrs.fill,parent?.fill ?? 'black'),
    fillOpacity:inherit(attrs['fill-opacity'],parent?.fillOpacity ?? '1')};
}

function bounds({sx,sy,tx,ty}, {x,y,width,height}) {
  const x1=sx*x+tx, y1=sy*y+ty, x2=sx*(x+width)+tx, y2=sy*(y+height)+ty;
  return {left:Math.min(x1,x2),top:Math.min(y1,y2),right:Math.max(x1,x2),bottom:Math.max(y1,y2)};
}

export function slotOverlayCheck(physical) {
  const slots=[], touched=new Set(), examples=[];
  let rectangleCount=0, pairCount=0, skippedSlots=0;
  return {
    slot(id,box,context) {
      if (!context) { skippedSlots++; return; }
      slots.push({id,occurrence:slots.length+skippedSlots+1,box:bounds(context.transform,box)});
    },
    rect(attrs,context,ordinal) {
      if (!slots.length || !context || !white(context.fill) || !opaque(context.fillOpacity)) return;
      const box={x:physical(attrs.x ?? 0),y:physical(attrs.y ?? 0),width:physical(attrs.width),height:physical(attrs.height)};
      if (physical(attrs.rx ?? 0)!==0 || physical(attrs.ry ?? 0)!==0 ||
          !Object.values(box).every(Number.isFinite) || !(box.width>0 && box.height>0)) return;
      const r=bounds(context.transform,box);
      let hit=false;
      for (const slot of slots) {
        const b=slot.box;
        const x=Math.max(r.left,b.left), y=Math.max(r.top,b.top);
        const width=Math.min(r.right,b.right)-x, height=Math.min(r.bottom,b.bottom)-y;
        if (!(width>0 && height>0)) continue;
        hit=true; pairCount++; touched.add(slot.occurrence);
        if (examples.length<32) examples.push({slot:slot.occurrence,id:slot.id,
          rectElement:ordinal,intersection:{x,y,width,height}});
      }
      if (hit) rectangleCount++;
    },
    report() {
      const unassessed=slots.length===0 && skippedSlots>0;
      return {slotCount:slots.length+skippedSlots,assessedSlots:slots.length,
        affectedSlots:unassessed?null:touched.size,rectangleCount:unassessed?null:rectangleCount,
        pairCount:unassessed?null:pairCount,examples,
        scope:'Later opaque white rectangles with positive-area overlap against unclipped slot boxes; geometry only. Complex transforms, nested viewports and translucent groups are skipped.'};
    }
  };
}

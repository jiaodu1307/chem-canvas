import {SaxesParser} from 'saxes';

const cssPx = {'':1,px:1,pt:96/72,pc:16,mm:96/25.4,cm:96/2.54,in:96,q:96/101.6};
const num = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numberRE = new RegExp('^'+num+'$');
const sizeRE = new RegExp('^('+num+')(px|pt|pc|mm|cm|in|q|em|%)?$','i');
function resolvedSize(input, parentSize) {
  if (input === undefined || /^(inherit|unset)$/.test(input)) return parentSize;
  const m=sizeRE.exec(input);
  if (!m || Number(m[1])<=0) return null;
  const unit=(m[2]??'').toLowerCase();
  const factor=unit==='em'?parentSize:unit==='%'?(parentSize===null?null:parentSize/100):cssPx[unit];
  return factor===null?null:Number(m[1])*factor;
}

// Only the linear part of a transform changes the nominal em size.
function multiply([a,b,c,d],[e,f,g,h]) {return [a*e+c*f,b*e+d*f,a*g+c*h,b*g+d*h];}
function transformed(matrix,value) {
  if (!matrix || !value || value==='none') return matrix;
  let rest=value.trim();
  while (rest) {
    const match=/^([A-Za-z]+)\(([^()]*)\)\s*,?\s*/.exec(rest);
    if (!match) return null;
    const args=match[2].trim().split(/[\s,]+/);
    if (!args.every(x=>numberRE.test(x))) return null;
    const [x,y,z,w]=args.map(Number), radians=x*Math.PI/180, n=args.length;
    let local;
    switch(match[1]) {
      case 'translate': if(n===1 || n===2)local=[1,0,0,1]; break;
      case 'scale': if(n===1 || n===2)local=[x,0,0,y??x]; break;
      case 'rotate': if(n===1 || n===3)local=[Math.cos(radians),Math.sin(radians),-Math.sin(radians),Math.cos(radians)]; break;
      case 'skewX': if(n===1)local=[1,0,Math.tan(radians),1]; break;
      case 'skewY': if(n===1)local=[1,Math.tan(radians),0,1]; break;
      case 'matrix': if(n===6)local=[x,y,z,w]; break;
    }
    if(!local)return null;
    matrix=multiply(matrix,local);
    rest=rest.slice(match[0].length);
  }
  return matrix.every(Number.isFinite)?matrix:null;
}

function inlineStyle(style) {
  return Object.fromEntries((style??'').split(';').map(s=>s.split(':').map(x=>x.trim())).filter(pair=>pair.length===2));
}
const noPaint=paint=>paint==='none' || paint==='transparent';
const zero=value=>/^(?:0+(?:\.0*)?|\.0+)%?$/.test(value??'');

export function measurePrintFonts(source, printWidthMm, viewport) {
  if (!Number.isFinite(printWidthMm) || printWidthMm<=0) throw Error('Print width must be a positive finite number of millimetres.');
  const parser=new SaxesParser({xmlns:true}),stack=[],runs=[];
  let textIndex=0, externalCSS=false;
  const rootMatrix=viewport && [printWidthMm/(viewport.right-viewport.left),0,0,
    printWidthMm*viewport.aspectHeightOverWidth/(viewport.bottom-viewport.top)];
  parser.on('processinginstruction',p=>{if(p.target==='xml-stylesheet')externalCSS=true;});
  parser.on('opentag',tag=>{
    const name=tag.local,p=stack.at(-1),a=Object.fromEntries(Object.values(tag.attributes).map(v=>[v.name,v.value]));
    const style=inlineStyle(a.style);
    if(name==='style' || (name==='link' && a.rel==='stylesheet'))externalCSS=true;
    const inText=name==='text' || p?.inText;
    const index=name==='text'?++textIndex:p?.index;
    const skip=p?.skip || tag.uri!=='http://www.w3.org/2000/svg' || (p && name==='svg') || ['defs','symbol','marker','clipPath','mask','pattern','textPath','foreignObject'].includes(name) ||
      (a['clip-path'] && a['clip-path']!=='none') || (a.mask && a.mask!=='none') || style['clip-path'] || style.mask ||
      (style.display??a.display)==='none' || ['hidden','collapse'].includes(style.visibility??a.visibility) ||
      zero(style.opacity??a.opacity) || (a.rotate && a.rotate!=='0') || style['writing-mode'] || a['writing-mode'];
    const font=style.font || a.font?null:resolvedSize(style['font-size']??a['font-size'],p?.font??null);
    const matrix=style.transform || style.scale || style.rotate?null:transformed(p?p.matrix:rootMatrix,a.transform);
    const inherit=(prop,fallback)=>style[prop]??a[prop]??p?.[prop]??fallback;
    stack.push({index,inText,skip,font,matrix,sourceId:inText?(a.id??p?.sourceId):undefined,
      fill:inherit('fill','black'),stroke:inherit('stroke','none'),
      'fill-opacity':inherit('fill-opacity','1'),'stroke-opacity':inherit('stroke-opacity','1')});
  });
  const textRun=raw=>{
    const node=stack.at(-1),text=raw.trim();
    if(!node?.inText || !text)return;
    const painted=(!noPaint(node.fill) && !zero(node['fill-opacity'])) || (!noPaint(node.stroke) && !zero(node['stroke-opacity']));
    const heightMm=painted && !node.skip && node.matrix && node.font?node.font*Math.hypot(node.matrix[2],node.matrix[3]):null;
    const pt=heightMm*72/25.4;
    runs.push({index:node.index,...(node.sourceId?{id:node.sourceId}:{}),text,
      pointSize:Number.isFinite(pt) && pt>0?Math.round(pt*100)/100:null});
  };
  parser.on('text',textRun);parser.on('cdata',textRun);parser.on('closetag',()=>stack.pop());
  parser.write(source).close();
  // A stylesheet could override any source attribute, even when it occurs after a label.
  if(externalCSS)for(const run of runs)run.pointSize=null;
  const sizes=runs.map(r=>r.pointSize).filter(n=>n!==null);
  return {printWidthMm,measuredRuns:sizes.length,unassessedRuns:runs.length-sizes.length,
    smallestPointSize:sizes.length?sizes.reduce((a,b)=>Math.min(a,b)):null,
    largestPointSize:sizes.length?sizes.reduce((a,b)=>Math.max(a,b)):null,runs,
    scope:'Nominal vertical em size in typographic points (72 pt/in), at the stated print width. Each run is a source text or tspan fragment. Paths have no declared font size. Clipped or nested viewports, unspecified or unsupported sizes, external styles and unsupported transforms are unassessed.'};
}

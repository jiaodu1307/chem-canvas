import { reactionScheme } from './reaction-scheme.js';
import { failure } from './store.js';
import { saveSchemeLayout } from '../src/core/index.js';

export async function editScheme(store, input) {
  const invalid=message=>{throw failure('VALIDATION',message);};
  if(!['preview','commit'].includes(input.mode) || !['agent','human'].includes(input.actor) || !Number.isSafeInteger(input.expectedLayoutVersion) || !Number.isSafeInteger(input.expectedRevision) || typeof input.operationId!=='string')invalid('Require mode, actor, operation ID and both versions.');
  if(Object.keys(input).some(key=>!['mode','actor','expectedRevision','expectedLayoutVersion','operationId','reflow','rowWidth','moves'].includes(key)))invalid('Only layout fields may be edited.');
  if(input.reflow!==undefined && typeof input.reflow!=='boolean' || input.rowWidth!==undefined && !input.reflow)invalid('rowWidth requires explicit reflow.');
  const moves=input.moves??[];
  if(!Array.isArray(moves)||moves.length>1000 || new Set(moves.map(move=>move?.id)).size!==moves.length)invalid('Expected at most 1000 distinct moves.');
  async function candidate(doc) {
    if(doc.revision!==input.expectedRevision || (doc.schemeLayout?.version??0)!==input.expectedLayoutVersion)throw failure('CONFLICT','Document or layout changed; reload and compare before editing.');
    const draft=await reactionScheme(input.reflow?{...doc,schemeLayout:undefined}:doc,{rowWidth:input.reflow?(input.rowWidth??doc.schemeLayout?.rowWidth):undefined});
    const positions=Object.fromEntries(draft.elements.map(({id,x,y})=>[id,{x,y}]));
    for(const move of moves){
      if(!move || Object.keys(move).some(key=>!['id','x','y'].includes(key)) || !Object.hasOwn(positions,move.id) || ![move.x,move.y].every(value=>Number.isFinite(value)&&value>=0&&value<=100000))invalid('Unknown display ID or invalid position.');
      positions[move.id]={x:move.x,y:move.y};
    }
    return {positions,rowWidth:draft.rowWidth,starts:draft.starts};
  }
  if(input.mode==='preview'){
    const doc=store.document, layout=await candidate(doc);
    return {...await reactionScheme({...doc,schemeLayout:{...layout,version:doc.schemeLayout?.version??0}}),state:'preview',layoutSource:'preview'};
  }
  const result=await store.mutate('scheme-edit',input,async doc=>saveSchemeLayout(doc,input,await candidate(doc)));
  return {...await reactionScheme(result.document),replayed:Boolean(result.replayed)};
}

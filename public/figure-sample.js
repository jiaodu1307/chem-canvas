const archive='/publication-benchmark-data';

export async function readFigureSample(runId,read=fetch){
  const registry=await read(archive+'/route-round/svg-compatibility.json');
  if(!registry.ok)throw Error('暂时无法读取公开绘图样例清单。');
  const {runs}=await registry.json();
  const entry=runs.find(run=>run.runId===runId);
  if(!entry || !/^[A-Za-z0-9_-]+$/.test(runId))throw Error('找不到这个公开 SVG 绘图样例。');
  const result=await read(archive+'/diagnostics/'+encodeURIComponent(entry.runId)+'/output.svg');
  if(!result.ok)throw Error('暂时无法读取样例 SVG。');
  return {source:await result.text(),caseId:entry.caseId,sourceSha256:entry.sourceSvgSha256};
}

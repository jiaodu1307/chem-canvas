import {readFile} from 'node:fs/promises';
import {checkSvgText} from '../server/svg-text-preflight.js';

try{
  const [file,flag,value,...extra]=process.argv.slice(2);
  if(!file || extra.length || (flag!==undefined && (flag!=='--print-width-mm' || !value)))
    throw Error('Usage: node scripts/check-svg-text.mjs figure.svg [--print-width-mm 85]');
  const report=checkSvgText(await readFile(file,'utf8'),{printWidthMm:flag?Number(value):undefined});
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.findings.length?1:0;
}catch(error){
  console.error(error.message);
  process.exitCode=2;
}

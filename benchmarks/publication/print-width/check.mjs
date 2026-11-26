import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startServer} from '../../../server/index.js';
import {createMcpServer} from '../../../server/mcp.js';
import {checkSvgText} from '../../../server/svg-text-preflight.js';

const root = new URL('../../../', import.meta.url);
const archive = 'public/publication-benchmark-data/';
const sources = [
  {name:'blind', file:'svg', developmentPath:archive+'diagnostics/hosoya-batch-oxidation-vector-from-data-2026-11-25T01-29-29-227Z-f6676549/output.svg',
    sha:'1fd1ddcbe6956796184bf31613145b79454f0aed7ab7b74f21d31cf5d5047fbe', cellSize:17, designWidth:1000},
  {name:'proofread', file:'proofread', developmentPath:archive+'data-only/hosoya-batch-oxidation/proofread.svg',
    sha:'389f4e758f373b51797190b8a186a2b4b88c4588a59d88bd2702662e956e6556', cellSize:12, designWidth:360},
];
const measurements = [
  '10 33.3 62.4 0.0 12', '20 16.3 81.0 0.0 26', '30 8.5 86.5 0.0 42', '40 3.9 94.6 0.1 63',
  '50 0.5 98.0 0.1 93', '60 0.0 98.8 0.3 100', '10 2.8 95.3 0.1 71', '20 0.0 98.1 0.7 100',
].flatMap(row => row.split(' '));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function readSource(fixture) {
  const published = new URL('docs/hosoya-batch-oxidation-'+fixture.file+'.svg', root);
  const input = await readFile(published, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(new URL(fixture.developmentPath, root), 'utf8');
  });
  const source = input.replaceAll('\r\n', '\n');
  assert.equal(sha(source), fixture.sha, fixture.name+' input digest');
  return source;
}

function tableRuns(fixture, runs) {
  if (fixture.name === 'proofread') {
    return measurements.map((value, i) => {
      const id = 'cell-'+(Math.floor(i/5)+1)+'-'+(i%5+1);
      const matching = runs.filter(run => run.id === id);
      assert.equal(matching.length, 1, id);
      return matching[0];
    });
  }
  // In the blind draft the editable numeric cells follow each series number and temperature.
  return [['5','60',30],['6','80',10]].flatMap(([series,temp,count]) => {
    const header = runs.findIndex((run,i) => run.text === series && runs[i+1]?.text === temp);
    assert.ok(header >= 0, 'series '+series+' at '+temp+' °C');
    return runs.slice(header+2, header+2+count);
  });
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'hosoya-print-'));
const app = await startServer({port:0, dataDirectory:directory});
const client = new Client({name:'hosoya-print-benchmark',version:'1'});
try {
  const [left,right] = InMemoryTransport.createLinkedPair();
  await createMcpServer(app.url,{projectId:'default'}).connect(right);
  await client.connect(left);
  const figure = async args => {
    const result = await client.callTool({name:'canvas_figure',arguments:args});
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const download = async revision => {
    const {downloadUrl} = await figure({mode:'export',expectedRevision:revision});
    const response = await fetch(downloadUrl);
    assert.ok(response.ok);
    return sha(Buffer.from(await response.arrayBuffer()));
  };
  const report = [];
  for (const fixture of sources) {
    const source = await readSource(fixture);
    const {revision} = await figure({mode:'read'});
    await figure({mode:'save',source,expectedRevision:revision,operationId:'seed-'+fixture.name});
    const saved = await figure({mode:'read'});
    const exportHash = await download(saved.revision);
    const preview = extra => figure({mode:'preview',source,includeImage:false,...extra});
    const ordinary = await preview({});
    assert.equal(ordinary.textPreflight, undefined);
    const checked = await preview({checkText:true});
    assert.ok(checked.textPreflight);
    assert.equal(checked.textPreflight.printFonts, undefined);
    const widths = [];
    for (const mm of [85,170]) {
      const measured = await preview({printWidthMm:mm});
      const actual = measured.textPreflight?.printFonts;
      assert.ok(actual, 'Missing printFonts at '+mm+' mm');
      const offline = checkSvgText(source,{printWidthMm:mm}).printFonts;
      assert.deepEqual(actual, offline, 'MCP and offline font reports');
      const cells = tableRuns(fixture, actual.runs);
      assert.deepEqual(cells.map(run => run.text), measurements, 'eight rows in time-series order');
      const pt = Math.round(fixture.cellSize * mm / fixture.designWidth * 72 / 25.4 * 100) / 100;
      assert.ok(cells.every(run => run.pointSize === pt), 'independent nominal point size');
      widths.push({printWidthMm:mm,tableRows:8,checkedCells:cells.length,cellPointSize:pt,smallestPointSize:actual.smallestPointSize});
    }
    assert.deepEqual(await figure({mode:'read'}), saved, 'previews must preserve the saved project');
    assert.equal(await download(saved.revision), exportHash, 'previews must preserve the downloaded SVG bytes');
    report.push({fixture:fixture.name,sourceSha256:fixture.sha,unchangedRevision:saved.revision,unchangedExportSha256:exportHash,widths});
  }
  console.log(JSON.stringify(report,null,2));
} finally {
  await client.close();
  await app.close();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('hosoya-print-'));
  await rm(directory,{recursive:true,force:true});
}

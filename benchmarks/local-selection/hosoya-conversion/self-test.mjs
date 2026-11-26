import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scorer = fileURLToPath(new URL('./score.mjs', import.meta.url));
const reference = await readFile(new URL('./example-export.svg', import.meta.url), 'utf8');
const temp = await mkdtemp(path.join(os.tmpdir(), 'hosoya-scoring-'));

function replaceOne(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Expected one occurrence of ' + before);
  return source.replace(before, after);
}

async function check(name, source, expected) {
  const file = path.join(temp, name + '.svg');
  await writeFile(file, source);
  const result = spawnSync(process.execPath, [scorer, file], {encoding: 'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status, expected.pass ? 0 : 1, name + ': ' + result.stderr);
  const report = JSON.parse(result.stdout);
  for (const [field, value] of Object.entries(expected)) assert.equal(report[field], value, name + ' ' + field);
  if (!expected.pass) assert.ok(report.outsideChangedPixels > 0, name);
  console.log(name, JSON.stringify(report));
}

try {
  const pass = {pass: true, rowsPreserved: 8, temperatureGroupsPreserved: 2,
    selectedMismatchPixels: 0, outsideChangedPixels: 0, controlChangedPixels: 0};
  await check('recorded-export', reference, pass);
  const row = 'transform="translate(0 546)"';
  const matrix = replaceOne(reference, row, 'transform="matrix(1 0 0 1 0 546)"');
  await check('equivalent-matrix', matrix, pass);

  // SVG applies the rightmost operation to a point first. At the series nodes
  // undo the outer translation and scale in reverse order, including the root.
  let nested = replaceOne(matrix, '<svg ', '<svg transform="translate(4 8)" ');
  nested = replaceOne(nested, '<title>', '<g transform="translate(-4 -8)"><title>');
  nested = replaceOne(nested, '</svg>', '</g></svg>');
  nested = replaceOne(nested, '<g font-size="17">', '<g font-size="17" transform="translate(8 12) scale(2)">');
  const inverse = 'transform="scale(.5) translate(-8 -12)"';
  for (const id of ['series-5', 'series-6']) {
    nested = replaceOne(nested, `<g id="${id}">`, `<g id="${id}" ${inverse}>`);
  }
  await check('nested-and-root', nested, pass);
  const series6 = `<g id="series-6" ${inverse}>`;
  const wrongOrder = replaceOne(nested, series6, '<g id="series-6" transform="translate(-8 -12) scale(.5)">');
  await check('reversed-order', wrongOrder, {pass: false, rowsPreserved: 6, temperatureGroupsPreserved: 1});
  const moved = replaceOne(reference, row, 'transform="matrix(1 0 0 1 0 548)"');
  await check('misplaced-row', moved, {pass: false, rowsPreserved: 7, temperatureGroupsPreserved: 2});
  const wrongValue = replaceOne(matrix, '>98.1</text>', '>98.0</text>');
  await check('incorrect-value', wrongValue, {pass: false, rowsPreserved: 7, temperatureGroupsPreserved: 2});
} finally {
  await rm(temp, {recursive: true, force: true});
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const names = ['canvas_adjust_depiction', 'canvas_apply', 'canvas_changes', 'canvas_edit_molecule', 'canvas_inspect_canvas', 'canvas_inspect_molecule', 'canvas_inspect_scheme', 'canvas_layout_molecule', 'canvas_list_resources', 'canvas_propose', 'canvas_put_molecule', 'canvas_read', 'canvas_undo', 'chemistry_parse'];
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
export function verifyContract(tools) {
  const schemas = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]));
  const incremental = !process.env.CHEM_ACCEPT_RUNTIME && Object.hasOwn(schemas,'canvas_edit_scheme');
  const cdxml = incremental && Object.hasOwn(schemas,'canvas_import_cdxml');
  assert.deepEqual(tools.map(tool => tool.name).sort(), incremental ? [...names,'canvas_edit_scheme','canvas_figure','canvas_publication',...(cdxml?['canvas_import_cdxml']:[])].sort() : names);
  for (const schema of Object.values(schemas)) assert.equal(schema.type, 'object');
  assert.equal(schemas.canvas_inspect_scheme.properties.rowWidth.minimum, 600);
  const digest = createHash('sha256').update(JSON.stringify(normalize(schemas))).digest('hex');
  if (incremental) {
    assert.deepEqual(schemas.canvas_edit_scheme.required,['expectedRevision','expectedLayoutVersion','operationId','mode']);
    assert.deepEqual(schemas.canvas_edit_scheme.properties.mode.enum,['preview','commit']);
    if (cdxml) {
      assert.deepEqual(schemas.canvas_import_cdxml.required,['cdxml','expectedRevision','operationId','mode']);
      assert.deepEqual(schemas.canvas_import_cdxml.properties.mode.enum,['preview','commit']);
      assert.equal(schemas.canvas_import_cdxml.properties.cdxml.maxLength,524288);
    }
  } else assert.equal(digest, 'b4b0a205bbbb2b18e4b77702776155e0a916cef75bb44011852436721d1d5c75');
  return digest;
}

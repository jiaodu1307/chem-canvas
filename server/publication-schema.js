import { abbreviationMode, headerTemplatesSchema } from './publication-header-template.js';
import { orientationProperties } from './publication-orientation.js';
import { ringVariationSchema } from './publication-ring-scope.js';
import { raisedLetter } from '../public/publication-yield.js';
const text = (maxLength) => ({ type: 'string', maxLength });
const requiredText = (maxLength) => ({ ...text(maxLength), minLength: 1, pattern: '\\S' });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = requiredText(200);
const kind = { enum: ['optimization', 'scope'] };
const ids = { type: 'array', items: id, maxItems: 12, uniqueItems: true };
const name = requiredText(80);
const byKind = (field) => object({ optimization: field, scope: field });
const terminalMarker = new RegExp('%'+raisedLetter+'$','u');
const yieldFields = {
  value: { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, requiredText(50)] },
  method: requiredText(80),
  footnoteMarker:{type:'string',pattern:'^'+raisedLetter+'$',description:'One printed superscript letter explicitly attached to this yield, e.g. ᵇ. It does not imply footnote wording.'},
};
export const additionalYieldsSchema = {
  type: 'array', maxItems: 16,
  description: 'Secondary yields of the same product, each with the corresponding experiment or measurement context.',
  items: object({ ...yieldFields, context: requiredText(320) }, ['value', 'context']),
};
export function outsideYieldRange(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim().replace(terminalMarker,'%').replace(/^−/,'-');
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/.test(text)) return false;
  const number = Number(text.replace('%', ''));
  return number < 0 || number > 100;
}
const conditionLines = { type: 'array', maxItems: 16, items: { anyOf: [
  requiredText(320), object({text:requiredText(320), color:{enum:['black','blue','red','green']}}, ['text'])
] } };
const experiment = object({
  id, compoundId: id, label: text(120), group: text(160),
  conditions: { type: 'object', propertyNames: name, maxProperties: 36, additionalProperties: text(800) },
  yield: object(yieldFields, ['value']),
  additionalYields: additionalYieldsSchema,
  selectivity: text(200), scale: text(160), note: text(1200), source: text(600),
  structureRole: {enum:['product','substrate'],description:'Role of the depicted compound when a scope entry shows a starting material alongside a reported product yield.'},
  include: { type: 'array', minItems: 1, maxItems: 2, items: kind, uniqueItems: true },
}, ['id']);
export const publicationSchema = object({
  title: requiredText(240), caption: text(1800), titles: byKind(requiredText(240)), captions: byKind(text(1800)),
  journal: { enum: ['orglett', 'obc'] }, columns: { enum: [1, 2] }, kind,
  abbreviations:{...abbreviationMode,default:'expanded'},
  abbreviationOverrides:{type:'object',propertyNames:id,maxProperties:500,additionalProperties:abbreviationMode,description:'Printed abbreviation mode per saved molecule ID. Applies wherever that molecule appears.'},
  alignScaffolds: { type:'boolean', description:'Set false to preserve the orientation of saved molecular drawings.' },
  scopeColumns: {type:'integer', minimum:1, maximum:8, description:'Number of product cards or scaffold panels across the scope artwork.'},
  scopeStyle: object({
    reactionOnly:{type:'boolean',description:'For a single reaction or competition experiment, print the reaction with its title, caption and footnotes. Product cards are omitted. Put visible yields in the reaction labels or caption; the experiment records remain editable.'},
    inlineConditions:{type:'boolean',description:'Set conditions beside the yield in scaffold entries. Long entries still wrap.'},
    entryFontPt:{type:'number',minimum:6,maximum:12,description:'Print font size for scaffold entries.'},
    alignPanelLabels:{type:'boolean',description:'Start the lists beneath scaffold illustrations on a common baseline.'},
    titleInCaption:{type:'boolean',description:'Print the scope title at the beginning of the caption.'},
    captionBand:{type:'boolean',description:'Use a pale gray background for the caption and footnotes.'},
    frame:{type:'boolean',description:'Draw a thin frame around the complete figure.'},
    aspectRatio:{type:'number',minimum:0.3,maximum:5,description:'Target width divided by height. Distribute spare height between panels. Taller content is retained in full.'},
  }),
  scopeBands: {type:'array', minItems:1,maxItems:500,description:'Explicit rows of mixed scope panels. Include every visible experiment once, either individually or via its scaffold group.',
    items:object({title:text(160),color:{enum:['black','red','blue','green']},items:{type:'array',minItems:1,maxItems:8,
      items:{oneOf:[object({entryId:id},['entryId']),object({scaffoldGroup:requiredText(160)},['scaffoldGroup'])]}}},['items'])},
  scopeYieldMethodInCaption: {type:'boolean',description:'Print the uniform yield method once below a scope, while retaining it on each editable measurement.'},
  scaffoldGroups: {type:'array',maxItems:32,description:'Match experiments by group; derive substituents from each saved product at the declared fixed attachment sites.',
    items:object({group:requiredText(160), smiles:requiredText(2000), title:text(160), abbreviations:abbreviationMode,ringVariation:ringVariationSchema,...orientationProperties,
      siteLabels:{type:'object',maxProperties:8,propertyNames:{pattern:'^R[1-9][0-9]?$'},additionalProperties:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9]{0,7}$'}}},['group','smiles'])},
  reaction: object({ reactantIds: ids, productIds: ids, conditions: text(800),
    reactantTemplates:headerTemplatesSchema, productTemplates:headerTemplatesSchema,
    conditionsAbove: conditionLines, conditionsBelow: conditionLines, catalystIds: ids,
    labels: { type:'object', propertyNames:id, maxProperties:36, additionalProperties:requiredText(120) },
    catalystRepeats: { type:'object', propertyNames:id, maxProperties:12, additionalProperties:{type:'integer',minimum:2,maximum:99} },
  }, ['reactantIds', 'productIds']),
  conditionColumns: { type: 'array', items: name, maxItems: 36, uniqueItems: true },
  experiments: { type: 'array', items: experiment, minItems: 1, maxItems: 500 },
}, ['title', 'journal', 'columns', 'kind', 'experiments']);


import test from 'node:test';
import assert from 'node:assert/strict';
import { _editingToolkit, parseSmiles, renderMolecule } from '../src/chemistry/index.js';
import { drawJournalAbbreviations } from '../src/chemistry/abbreviations.js';
import { previewPublication } from '../server/publication.js';

const aliases=svg=>[...svg.matchAll(/data-rdkit-abbreviations="([^"]+)"/g)].flatMap(m=>m[1].split(','));

test('native printed formyl reads CHO at right and OHC at left with only one bond to the ring',async()=>{
  const kit=await _editingToolkit();
  const mol=kit.get_mol('O=Cc1ccccc1');
  try {
    mol.set_new_coords(false);
    const before=mol.get_v3Kmolblock();
    for (const [rotate,expected] of [[0,'CHO'],[180,'OHC']]) {
      const {svg}=drawJournalAbbreviations(mol,undefined,display=>{
        const {atoms,bonds}=JSON.parse(display.get_json()).molecules[0];
        assert.equal(atoms[0].z,0);
        assert.deepEqual(bonds.filter(b=>b.atoms.includes(0)),[{atoms:[0,1]}]);
        return {svg:display.get_svg_with_highlights(JSON.stringify({noFreetype:true,width:-1,height:-1,rotate}))};
      });
      const glyphs=[...svg.matchAll(/<text x='([-.\d]+)'[^>]+class='atom-0'[^>]*>([^<]+)<\/text>/g)];
      assert.equal(glyphs.sort((a,b)=>Number(a[1])-Number(b[1])).map(m=>m[2]).join(''),expected);
    }
    assert.equal(mol.get_v3Kmolblock(),before);
  } finally {mol.delete();}
});

test('publication mode matches actual RDKit aliases and protects distinctive chemistry',async()=>{
  for (const [smiles,expected] of [
    ['O=Cc1ccc(OC)cc1',['CHO','OMe']], ['O=C(O)c1ccccc1',['CO2H']],
    ['CC(=O)c1ccccc1',['Ac']], ['COC(=O)c1ccccc1',['OMe']],
    ['O=Cc1ccc([N+](=O)[O-])cc1',['CHO','NO2']],
    ['O=Cc1ccc([C@H](F)Cl)cc1',['CHO']], ['O=Cc1ccc(/C=C/F)cc1',['CHO']],
    ...['OCc1ccccc1','O=COc1ccccc1','O=CNc1ccccc1','[18O]=Cc1ccccc1','O=[13CH]c1ccccc1',
      '[2H]C(=O)c1ccccc1','O=[C]c1ccccc1','[OH+]=Cc1ccccc1','O=[CH:7]c1ccccc1'].map(s=>[s,[]]),
  ]) {
    const data=await parseSmiles(smiles),saved=structuredClone(data);
    const original=(await renderMolecule(data)).svg;
    assert.equal((await renderMolecule(data,{abbreviations:'expanded'})).svg,original,smiles);
    const printed=(await renderMolecule(data,{abbreviations:'journal'})).svg;
    assert.deepEqual(aliases(printed).sort(),expected.sort(),smiles);
    if (!expected.length) assert.equal(printed,original,smiles);
    if (smiles.includes('@')) assert.match(printed,/class='bond-\d+ atom-\d+ atom-\d+' d='M [^']+ Z'/,'native stereo wedge');
    assert.deepEqual(data,saved);
  }
});

test('a double-bond reference ligand can be printed at its matched CF3 attachment without changing E/Z',async()=>{
  const kit=await _editingToolkit();
  for (const halogen of ['Cl','I']) for (const [slash,stereo] of [['/','E'],['\\','Z']]) {
    const smiles=halogen+'/C(=C'+slash+'C(F)(F)F)C(F)(F)F';
    const data=await parseSmiles(smiles);
    const mol=kit.get_mol(data.molblock);
    try {
      const before=mol.get_v3Kmolblock();
      const printed=drawJournalAbbreviations(mol,undefined,display=>{
        const {atoms,bonds,conformers}=JSON.parse(display.get_json()).molecules[0];
        const db=bonds.find(b=>b.bo===2);
        const [left,right]=db.atoms;
        const neighbor=(i,z)=>bonds.filter(b=>b.atoms.includes(i)).flatMap(b=>b.atoms).find(j=>atoms[j].z===z);
        const coords=conformers[0].coords;
        const [ax,ay]=coords[left], [bx,by]=coords[right];
        const side=([x,y])=>(bx-ax)*(y-ay)-(by-ay)*(x-ax);
        const hal=neighbor(left,halogen==='Cl'?17:53), distalCF3=neighbor(right,0);
        assert.equal(side(coords[hal])*side(coords[distalCF3])<0?'E':'Z',stereo);
        return {svg:display.get_svg()};
      });
      assert.deepEqual(aliases(printed.svg),['CF3','CF3']);
      assert.equal(mol.get_v3Kmolblock(),before);
      assert.equal(JSON.parse(mol.get_stereo_tags()).CIP_bonds[0][2],'('+stereo+')');
    } finally {mol.delete();}
  }
  const isotope=await parseSmiles('Cl/C(=C/C(F)(F)[18F])C(F)(F)F');
  assert.equal((await renderMolecule(isotope,{abbreviations:'journal'})).svg,(await renderMolecule(isotope)).svg);
  const unplaced=kit.get_mol('Cl/C(=C/C(F)(F)F)C(F)(F)F');
  try {
    assert.equal(unplaced.has_coords(),0);
    const result=drawJournalAbbreviations(unplaced,undefined,shown=>({svg:shown.get_svg()}));
    assert.deepEqual(aliases(result.svg),[]);
  } finally {unplaced.delete();}
});

test('saved study preview passes per-molecule and individual template overrides through both outputs',async()=>{
  const doc={revision:0,objects:{
    p:{kind:'molecule',data:await parseSmiles('O=Cc1ccc(F)cc1')},
    q:{kind:'molecule',data:await parseSmiles('O=Cc1ccc(Cl)cc1')},
  }};
  const saved=structuredClone(doc);
  const fixed={smiles:'O=Cc1ccc([*:1])cc1'};
  const ring={smiles:'O=Cc1ccccc1',ringVariation:{label:'R¹',anchor:2,sites:[3,4,5]}};
  const spec={title:'Mixed printed substituents',kind:'scope',journal:'obc',columns:2,abbreviations:'journal',
    abbreviationOverrides:{q:'expanded'},
    scaffoldGroups:[{...fixed,group:'fixed',abbreviations:'expanded'},{...ring,group:'ring'}],
    reaction:{reactantIds:['p'],productIds:['q'],reactantTemplates:[fixed],
      productTemplates:[{smiles:ring.smiles,ringAttachments:[{label:'R¹',sites:[3,4,5]}],abbreviations:'expanded'}]},
    experiments:[{id:'1',compoundId:'p',group:'fixed'},{id:'2',compoundId:'p',group:'ring'},
      {id:'3',compoundId:'p',group:'single'},{id:'4',compoundId:'q',group:'single'}]};
  const result=await previewPublication(doc,spec);
  assert.deepEqual(aliases(result.reactionSvg),['CHO','CHO']);
  assert.deepEqual(aliases(result.svg),['CHO','CHO','CHO','CHO']);
  assert.match(result.svg,/data-scope-group="single" data-scaffold-alignment="verified"/);
  const scopeCards=result.svg.slice(result.svg.indexOf('data-scope-group="single"'));
  const cardAliases=id=>aliases(scopeCards.split('data-compound-id="'+id+'"')[1].split('</g>')[0]);
  assert.deepEqual(cardAliases('p'),['CHO']);assert.deepEqual(cardAliases('q'),[]);
  assert.match(result.svg,/R¹ = p-F/);assert.match(result.svg,/R1 = F/);
  const all=structuredClone(spec);
  delete all.abbreviationOverrides;delete all.scaffoldGroups[0].abbreviations;delete all.reaction.productTemplates[0].abbreviations;
  const enabled=await previewPublication(doc,all);
  assert.equal(aliases(enabled.reactionSvg).length,4);
  assert.equal(aliases(enabled.svg).length,8);
  await assert.rejects(previewPublication(doc,{...spec,abbreviationOverrides:{missing:'journal'}}),/Missing saved molecule/);
  await assert.rejects(previewPublication(doc,{...spec,abbreviations:'typo'}),/journal/);
  assert.deepEqual(doc,saved);
});

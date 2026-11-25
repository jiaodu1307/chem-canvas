export const pairedCases = ['fujita-dioxytosylation', 'kirij-scheme5', 'hosoya-batch-oxidation'];

// Only this brief is sent to the drawing agent. References and the gold standard stay with evaluators.
export function briefFile(id) {
  if (!pairedCases.includes(id)) throw Error('Unknown data-only case');
  return new URL('./cases/' + id + '/brief.txt', import.meta.url);
}

export const pairedTask = 'Prepare one editable organic chemistry manuscript figure using only the study data below. Draw the skeletal structures of the specified reactants and products. Show their reaction relationships and the reported experimental outcomes, preserving units, qualifiers and known or unassigned stereochemistry. You may choose a compact and legible arrangement. Do not identify or look up the paper.';

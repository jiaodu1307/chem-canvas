const profiles = {
  full: null,
  figure: ['canvas_figure'],
  'figure-chemistry': ['canvas_figure', 'canvas_put_molecule', 'chemistry_parse'],
};

export function toolsForProfile(profile = 'full') {
  if (!Object.hasOwn(profiles, profile)) {
    throw new Error('Unknown Chem Canvas tool profile. Choose full, figure or figure-chemistry.');
  }
  return profiles[profile];
}

// Shared by the stdio-config printer and the checked-in Codex package preparer.
export function profileArgs(args) {
  const position = args.indexOf('--profile');
  if (position < 0) return { args, env: {} };
  const name = args[position + 1];
  if (!name) throw new Error('Supply full, figure or figure-chemistry after --profile.');
  toolsForProfile(name);
  return {
    args: [...args.slice(0, position), ...args.slice(position + 2)],
    env: { CHEM_CANVAS_TOOL_PROFILE: name },
  };
}

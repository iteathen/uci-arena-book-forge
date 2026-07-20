const requiredPolicyKeys = new Set([
  'prior_games', 'draw_value', 'confidence_standard_errors', 'minimum_games', 'maximum_lcb_gap',
  'quality_exponent', 'maximum_rarity_multiplier', 'exit_intercept', 'exit_depth_weight',
  'exit_advantage_weight', 'exit_disadvantage_weight', 'exit_weakness_weight', 'eval_deadband_cp',
  'eval_scale_cp', 'depth_start_ply', 'depth_span_plies',
]);

export function parsePolicy(text) {
  const policy = {};
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Malformed policy line: ${original}`);
    const key = line.slice(0, separator).trim();
    if (!requiredPolicyKeys.has(key)) throw new Error(`Unknown policy key: ${key}`);
    if (Object.hasOwn(policy, key)) throw new Error(`Duplicate policy key: ${key}`);
    const value = Number(line.slice(separator + 1).trim());
    if (!Number.isFinite(value)) throw new Error(`Invalid policy value for ${key}`);
    policy[key] = value;
  }
  for (const key of requiredPolicyKeys) if (!Object.hasOwn(policy, key)) throw new Error(`Missing policy key: ${key}`);
  if (policy.prior_games < 0 || policy.draw_value < 0 || policy.draw_value > 1 ||
      policy.confidence_standard_errors < 0 || !Number.isInteger(policy.minimum_games) || policy.minimum_games < 1 ||
      policy.maximum_lcb_gap <= 0 || policy.quality_exponent < 0 || policy.maximum_rarity_multiplier < 1 ||
      policy.eval_scale_cp <= 0 || policy.depth_span_plies <= 0) {
    throw new Error('Policy values violate the opening-book numeric contract');
  }
  return policy;
}

export function scoreSiblingCandidates(siblings, policy, maximumLcbGap = policy.maximum_lcb_gap) {
  if (!siblings.length) return { bestLcb: 0, maxGames: 0, eligible: [] };
  const totalGames = siblings.reduce((sum, row) => sum + row.games, 0);
  const scoredPoints = siblings.reduce((sum, row) => sum + row.wins + policy.draw_value * row.draws, 0);
  const positionMean = totalGames > 0 ? scoredPoints / totalGames : 0.5;
  for (const row of siblings) {
    row.posterior = (row.wins + policy.draw_value * row.draws + policy.prior_games * positionMean) /
      (row.games + policy.prior_games);
    row.standardError = Math.sqrt(row.posterior * (1 - row.posterior) / (row.games + policy.prior_games + 1));
    row.lcb = row.posterior - policy.confidence_standard_errors * row.standardError;
  }
  const bestLcb = Math.max(...siblings.map((row) => row.lcb));
  const maxGames = Math.max(...siblings.map((row) => row.games));
  const eligible = siblings.filter((row) => row.games >= policy.minimum_games && row.lcb >= bestLcb - maximumLcbGap);
  for (const row of eligible) {
    const quality = Math.max(0, Math.min(1, (row.lcb - (bestLcb - maximumLcbGap)) / maximumLcbGap));
    row.quality = quality;
    row.rarity = Math.min(policy.maximum_rarity_multiplier, Math.sqrt(maxGames / (row.games + 1)));
    row.qualityWeight = Math.max(1e-9, quality ** policy.quality_exponent);
    row.selectionWeight = row.qualityWeight * row.rarity;
  }
  return { bestLcb, maxGames, eligible };
}

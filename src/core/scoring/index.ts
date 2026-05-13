/**
 * @module    scoring
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       A
 * @audit     true
 * @owner     William J. Storey III / ACE / GIA
 */
export { GovernanceScorer, type IScoringCriteria } from './scorer.js';
export { calculateComposite, aggregateScores } from './composite.js';

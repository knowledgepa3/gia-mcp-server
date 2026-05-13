/**
 * @module    supervisor
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M — supervisor decisions are MANDATORY
 * @audit     true — every supervisor action is recorded
 * @owner     William J. Storey III / ACE / GIA
 */

import {
  SupervisorAction, type ISupervisorDecision, type IGovernanceScore,
  MaiClassification, EntryStatus,
} from '../../shared/types.js';
import { MAX_REPAIR_ATTEMPTS, MIN_COMPOSITE_SCORE, SCORE_HALT_THRESHOLD } from '../../shared/constants.js';
import { SupervisorHaltError } from '../../shared/errors.js';
import { utcNow } from '../../shared/utils.js';
import { ForensicLedger } from '../audit/ledger.js';

interface IAgentState {
  name: string;
  repairAttempts: number;
  lastScore?: IGovernanceScore;
  lastStatus: EntryStatus;
  consecutiveFailures: number;
}

/**
 * Supervisor — monitors agent operations and enforces governance decisions.
 *
 * The Supervisor watches agent outputs, scores, and error patterns.
 * It decides: CONTINUE, REPAIR, ESCALATE, or HALT.
 */
export class Supervisor {
  private agentStates: Map<string, IAgentState> = new Map();

  constructor(private readonly ledger: ForensicLedger) {}

  /**
   * Evaluate agent output and decide supervisor action.
   *
   * @governance  Supervisor monitors ALL agents.
   * @ledger      Decision recorded to forensic ledger.
   * @mai         Supervisor decisions are MANDATORY.
   * @failure     Throws SupervisorHaltError when halting pipeline.
   */
  evaluate(
    agentName: string,
    score: IGovernanceScore,
    status: EntryStatus,
    auditId: string
  ): ISupervisorDecision {
    const state = this.getOrCreateState(agentName);
    state.lastScore = score;
    state.lastStatus = status;

    // Track failures
    if (status === EntryStatus.FAILED) {
      state.consecutiveFailures++;
    } else {
      state.consecutiveFailures = 0;
    }

    // Decision logic
    const action = this.determineAction(state, score);
    const decision: ISupervisorDecision = {
      action,
      rationale: this.buildRationale(state, score, action),
      targetAgent: agentName,
      repairAttempts: state.repairAttempts,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      timestamp: utcNow(),
    };

    // Update state based on decision
    if (action === SupervisorAction.REPAIR) {
      state.repairAttempts++;
    } else if (action === SupervisorAction.CONTINUE) {
      state.repairAttempts = 0;
    }

    // HALT throws — pipeline cannot continue
    if (action === SupervisorAction.HALT) {
      throw new SupervisorHaltError(agentName, decision.rationale, auditId);
    }

    return decision;
  }

  /**
   * Reset agent state (e.g., after successful repair).
   */
  resetAgent(agentName: string): void {
    this.agentStates.delete(agentName);
  }

  /**
   * Get current state of all monitored agents.
   */
  getAllStates(): Map<string, IAgentState> {
    return new Map(this.agentStates);
  }

  private getOrCreateState(agentName: string): IAgentState {
    if (!this.agentStates.has(agentName)) {
      this.agentStates.set(agentName, {
        name: agentName, repairAttempts: 0,
        lastStatus: EntryStatus.STARTED, consecutiveFailures: 0,
      });
    }
    return this.agentStates.get(agentName)!;
  }

  private determineAction(state: IAgentState, score: IGovernanceScore): SupervisorAction {
    // HALT: score below halt threshold
    if (score.composite < SCORE_HALT_THRESHOLD) {
      return SupervisorAction.HALT;
    }

    // HALT: too many consecutive failures
    if (state.consecutiveFailures >= 3) {
      return SupervisorAction.HALT;
    }

    // HALT: exceeded max repair attempts
    if (state.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      return SupervisorAction.HALT;
    }

    // ESCALATE: failed status with repair attempts remaining
    if (state.lastStatus === EntryStatus.FAILED && state.repairAttempts > 0) {
      return SupervisorAction.ESCALATE;
    }

    // REPAIR: score below review threshold but above halt
    if (score.composite < MIN_COMPOSITE_SCORE) {
      return SupervisorAction.REPAIR;
    }

    // REPAIR: failed with no prior attempts
    if (state.lastStatus === EntryStatus.FAILED) {
      return SupervisorAction.REPAIR;
    }

    return SupervisorAction.CONTINUE;
  }

  private buildRationale(state: IAgentState, score: IGovernanceScore, action: SupervisorAction): string {
    switch (action) {
      case SupervisorAction.CONTINUE:
        return `Agent ${state.name} operating normally. Score: ${score.composite.toFixed(3)}.`;
      case SupervisorAction.REPAIR:
        return `Agent ${state.name} requires repair. Score: ${score.composite.toFixed(3)}. Attempt ${state.repairAttempts + 1}/${MAX_REPAIR_ATTEMPTS}.`;
      case SupervisorAction.ESCALATE:
        return `Agent ${state.name} repair unsuccessful. Escalating. Attempts: ${state.repairAttempts}/${MAX_REPAIR_ATTEMPTS}.`;
      case SupervisorAction.HALT:
        return `Agent ${state.name} halted. Score: ${score.composite.toFixed(3)}. Failures: ${state.consecutiveFailures}. Repairs: ${state.repairAttempts}/${MAX_REPAIR_ATTEMPTS}.`;
    }
  }
}

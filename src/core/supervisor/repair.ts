/**
 * @module    repair
 * @layer     GOVERNANCE
 * @inherits  supervisor
 * @mai       A — repair attempts are ADVISORY
 * @audit     true
 * @owner     William J. Storey III / ACE / GIA
 */

import { type ISupervisorDecision, SupervisorAction } from '../../shared/types.js';

export interface IRepairStrategy {
  name: string;
  description: string;
  execute: (agentName: string, context: Record<string, unknown>) => Promise<boolean>;
}

/**
 * RepairEngine — executes automated repair strategies for failing agents.
 */
export class RepairEngine {
  private strategies: Map<string, IRepairStrategy> = new Map();

  registerStrategy(strategy: IRepairStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  async attemptRepair(
    decision: ISupervisorDecision,
    context: Record<string, unknown>
  ): Promise<boolean> {
    if (decision.action !== SupervisorAction.REPAIR) return false;

    // Try each registered strategy in order
    for (const [_name, strategy] of this.strategies) {
      try {
        const success = await strategy.execute(decision.targetAgent, context);
        if (success) return true;
      } catch {
        // Strategy failed — try next
        continue;
      }
    }
    return false;
  }

  getStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }
}

/**
 * @module    mai-classifier
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M — classification decisions are MANDATORY governance events
 * @audit     true — every classification is recorded
 * @owner     William J. Storey III / ACE / GIA
 */

import {
  MaiClassification, type IMaiResult, type IMaiElevationRule,
  type IMaiVerticalConfig,
} from '../../shared/types.js';
import { MAI_PRIORITY, DEFAULT_ELEVATION_RULES, type IClassificationContext } from './types.js';

export class MaiClassifier {
  private verticalConfigs: Map<string, IMaiVerticalConfig> = new Map();
  private globalElevationRules: IMaiElevationRule[] = [...DEFAULT_ELEVATION_RULES];

  /**
   * Register a vertical's MAI configuration.
   * Each vertical declares its agent base classifications and elevation rules.
   */
  registerVertical(config: IMaiVerticalConfig): void {
    this.verticalConfigs.set(config.vertical, config);
  }

  /**
   * Classify a decision using the MAI Framework.
   *
   * @governance  Every AI agent action MUST be classified before execution.
   * @ledger      Classification result recorded to forensic ledger by caller.
   * @mai         This IS the MAI engine — it classifies everything else.
   * @failure     Returns highest classification (MANDATORY) on any error.
   */
  classify(operation: string, baseLevel: MaiClassification, context: IClassificationContext): IMaiResult {
    let effectiveLevel = baseLevel;
    let elevatedFrom: MaiClassification | undefined;
    let elevationReason: string | undefined;

    // Check vertical-specific agent classification
    if (context.vertical && context.agentName) {
      const verticalConfig = this.verticalConfigs.get(context.vertical);
      if (verticalConfig) {
        const agentBase = verticalConfig.agentClassifications[context.agentName];
        if (agentBase && MAI_PRIORITY[agentBase] > MAI_PRIORITY[effectiveLevel]) {
          elevatedFrom = effectiveLevel;
          effectiveLevel = agentBase;
          elevationReason = `Vertical ${context.vertical} agent ${context.agentName} base classification`;
        }
      }
    }

    // Apply elevation rules — context elevates, NEVER reduces (Rule 2)
    const allRules = this.getApplicableRules(context);
    for (const rule of allRules) {
      if (this.evaluateCondition(rule.condition, context)) {
        if (MAI_PRIORITY[rule.elevateTo] > MAI_PRIORITY[effectiveLevel]) {
          elevatedFrom = elevatedFrom ?? effectiveLevel;
          effectiveLevel = rule.elevateTo;
          elevationReason = rule.description;
        }
      }
    }

    // Calculate confidence based on how clear the classification is
    const confidence = this.calculateConfidence(effectiveLevel, context, elevatedFrom);

    return {
      classification: effectiveLevel,
      confidence,
      rationale: this.buildRationale(operation, effectiveLevel, context, elevationReason),
      elevatedFrom,
      elevationReason,
      requiresGate: effectiveLevel === MaiClassification.MANDATORY || effectiveLevel === MaiClassification.ADVISORY,
    };
  }

  /**
   * Elevate a classification based on context.
   * Context elevates, NEVER reduces (MAI Rule 2).
   */
  elevate(baseLevel: MaiClassification, context: IClassificationContext): MaiClassification {
    const result = this.classify('elevation-check', baseLevel, context);
    return result.classification;
  }

  private getApplicableRules(context: IClassificationContext): IMaiElevationRule[] {
    const rules = [...this.globalElevationRules];
    if (context.vertical) {
      const verticalConfig = this.verticalConfigs.get(context.vertical);
      if (verticalConfig) {
        rules.push(...verticalConfig.elevationRules);
      }
    }
    return rules;
  }

  private evaluateCondition(condition: string, context: IClassificationContext): boolean {
    const isExternal = context.outputAudience === 'CLIENT' || context.outputAudience === 'PUBLIC';
    switch (condition) {
      case 'pii_detected':             return context.piiDetected;
      case 'client_facing_output':     return isExternal;
      case 'financial_impact':         return context.hasFinancialImpact;
      // Legacy rule — kept for backward compat with vertical configs that still use 'legal_assertion'
      case 'legal_assertion':          return context.hasLegalImpact && isExternal;
      // Context-aware legal rules (2026-05-08): external → MANDATORY, internal → ADVISORY
      case 'legal_assertion_external': return context.hasLegalImpact && isExternal;
      case 'legal_assertion_internal': return context.hasLegalImpact && !isExternal;
      case 'medical_language':         return context.inputSensitivity === 'SOVEREIGN';
      case 'cue_identified':           return (context as unknown as Record<string, unknown>)['cueIdentified'] === true;
      default: return false;
    }
  }

  private calculateConfidence(level: MaiClassification, context: IClassificationContext, wasElevated?: MaiClassification): number {
    let confidence = 0.85; // Base confidence
    if (wasElevated) confidence += 0.05; // Elevation rules are deterministic
    if (context.piiDetected && level === MaiClassification.MANDATORY) confidence += 0.10;
    if (context.outputAudience === 'CLIENT' && level === MaiClassification.MANDATORY) confidence += 0.05;
    return Math.min(confidence, 1.0);
  }

  private buildRationale(operation: string, level: MaiClassification, context: IClassificationContext, elevationReason?: string): string {
    const parts = [`Operation '${operation}' classified as ${level}.`];
    if (elevationReason) parts.push(`Elevated: ${elevationReason}.`);
    if (context.piiDetected) parts.push('PII detected in input.');
    if (context.outputAudience === 'CLIENT') parts.push('Output is client-facing.');
    return parts.join(' ');
  }
}

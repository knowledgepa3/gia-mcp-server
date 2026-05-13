/**
 * @module    impact-report-template
 * @layer     TRANSPORT
 * @mai       INFORMATIONAL — read-only report formatting
 * @audit     false — no side effects
 * @owner     William J. Storey III / ACE / GIA
 *
 * Formats GIA impact report data into a client-facing deliverable.
 *
 * Input: Raw impact report from generate_impact_report MCP tool
 * Output: Formatted markdown suitable for PDF export or executive review
 *
 * Usage:
 *   1. Call generate_impact_report MCP tool to get raw data
 *   2. Pass to formatImpactReport() for client deliverable
 */

interface ImpactData {
  period: { days: number; start: string; end: string };
  workflows: {
    total: number;
    successful: number;
    successRate: number;
    byType: Record<string, number>;
    byAutonomy: Record<string, number>;
    byComplexity: Record<string, number>;
  };
  economics: {
    totalTimeSavedMinutes: number;
    totalTimeSavedHours: number;
    humanCostSaved: number;
    modelCostIncurred: number;
    netSavings: number;
    roi: number;
    costPerSuccessfulWorkflow: number;
    breakEvenWorkflows: number;
  };
  governance: {
    totalEvents: number;
    gatesTriggered: number;
    driftPrevented: number;
    violationsBlocked: number;
    redteamResolved: number;
    humanInterventions: number;
    estimatedCostAvoided: number;
  };
  confidence: {
    level: string;
    measuredPct: number;
    estimatedPct: number;
    derivedPct: number;
  };
}

export function formatImpactReport(
  data: ImpactData,
  clientName: string,
  domain: string,
): string {
  const now = new Date().toISOString().split('T')[0];

  return `
# GIA Governance Impact Report

**Client:** ${clientName}
**Domain:** ${domain}
**Period:** ${data.period.days} days (${data.period.start} — ${data.period.end})
**Generated:** ${now}
**Confidence:** ${data.confidence.level} (${data.confidence.measuredPct}% measured)

---

## Executive Summary

Over ${data.period.days} days, GIA governance delivered:

| Metric | Value |
|--------|-------|
| **Time Saved** | ${data.economics.totalTimeSavedHours.toFixed(1)} hours |
| **Cost Avoided** | $${data.economics.humanCostSaved.toLocaleString()} |
| **Risks Blocked** | ${data.governance.violationsBlocked} unsafe actions |
| **Incidents Prevented** | ${data.governance.estimatedCostAvoided > 0 ? '$' + data.governance.estimatedCostAvoided.toLocaleString() + ' exposure avoided' : 'No incidents'} |
| **Success Rate** | ${(data.workflows.successRate * 100).toFixed(1)}% |
| **Net ROI** | ${data.economics.roi.toFixed(0)}% |

---

## Workflow Analysis

**Total Workflows:** ${data.workflows.total} | **Successful:** ${data.workflows.successful}

### By Autonomy Level

| Level | Count | Description |
|-------|-------|-------------|
| Assist | ${data.workflows.byAutonomy['assist'] || 0} | Human does the work, AI helps |
| Delegate | ${data.workflows.byAutonomy['delegate'] || 0} | AI does the work, human reviews |
| Automate | ${data.workflows.byAutonomy['automate'] || 0} | AI works autonomously |

### By Complexity

| Level | Count |
|-------|-------|
| Low | ${data.workflows.byComplexity['low'] || 0} |
| Medium | ${data.workflows.byComplexity['medium'] || 0} |
| High | ${data.workflows.byComplexity['high'] || 0} |

---

## Economic Impact

| Metric | Value |
|--------|-------|
| Human time saved | ${data.economics.totalTimeSavedHours.toFixed(1)} hours |
| Cost saved (labor) | $${data.economics.humanCostSaved.toLocaleString()} |
| AI model cost | $${data.economics.modelCostIncurred.toFixed(2)} |
| **Net savings** | **$${data.economics.netSavings.toLocaleString()}** |
| Cost per workflow | $${data.economics.costPerSuccessfulWorkflow.toFixed(2)} |
| Break-even point | ${data.economics.breakEvenWorkflows} workflows |
| **ROI** | **${data.economics.roi.toFixed(0)}%** |

---

## Governance Events

| Event Type | Count |
|-----------|-------|
| MANDATORY gates triggered | ${data.governance.gatesTriggered} |
| Drift prevented | ${data.governance.driftPrevented} |
| Violations blocked | ${data.governance.violationsBlocked} |
| Red team findings resolved | ${data.governance.redteamResolved} |
| Human interventions | ${data.governance.humanInterventions} |
| **Estimated cost avoided** | **$${data.governance.estimatedCostAvoided.toLocaleString()}** |

---

## Compliance Posture

GIA's MAI (Mandatory/Advisory/Informational) classification framework ensures:

- **Every AI decision** is classified before execution
- **High-risk actions** require human approval (MANDATORY gate)
- **All operations** produce hash-chained forensic audit trail
- **Regulatory mapping** to NIST AI RMF, EU AI Act, ISO 42001, NIST 800-53

---

## Data Confidence

| Source | Percentage |
|--------|-----------|
| Measured (instrumented) | ${data.confidence.measuredPct}% |
| Estimated | ${data.confidence.estimatedPct}% |
| Derived | ${data.confidence.derivedPct}% |

**Overall confidence: ${data.confidence.level}**

${data.confidence.level === 'low' ? '> Note: Confidence improves as more workflows are instrumented with measured metrics.' : ''}

---

*Report generated by GIA (Governed Intelligence Architecture)*
*Author: William J. Storey III / ACE Advising*
*https://gia.aceadvising.com*
`.trim();
}

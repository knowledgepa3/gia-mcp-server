/**
 * @module    receipt-emitter
 * @layer     GOVERNANCE
 * @inherits  external-evidence
 * @mai       N/A — reads the chain head; writes nothing to the ledger
 * @audit     false — receipts are ABOUT the audit chain, delivered off-box
 * @owner     William J. Storey III / ACE / GIA
 *
 * CHAIN-HEAD RECEIPTS — the independent-witness experiment (R-6b anchoring).
 *
 * GIA's ledger verification is internal: like any system, it ultimately attests
 * to itself. A receipt is a compact, content-free statement of the chain head
 * (instance, head hash, chain index, timestamp) delivered to a NEUTRAL
 * COUNTERPARTY (MIR is the candidate), so a retroactive edit to GIA's record
 * becomes provable by a party outside GIA.
 *
 * This module is READ-ONLY toward the ledger: it consumes a chain head handed
 * to it — it performs no INSERT/UPDATE anywhere near forensic_ledger (stop-list
 * rule honored). The default sink is explicitly NOT_CONFIGURED; a real MIR sink
 * lands post-NDA, behind the same gate as the evidence provider.
 */

export interface IChainHeadReceipt {
  receiptVersion: 1;
  /** Stable identifier of the GIA instance the head belongs to. */
  instanceId: string;
  /** SHA-256 head hash of the chain at emission time (64 lowercase/uppercase hex chars). */
  headHash: string;
  /** Chain index the head hash corresponds to. */
  chainIndex: number;
  /** ISO timestamp the receipt was generated. */
  generatedAt: string;
}

export interface IReceiptDeliveryOutcome {
  delivered: boolean;
  reason?: string;
  /** Provider-assigned id for the stored receipt, when delivered. */
  receiptId?: string;
}

/** A pluggable receipt counterparty. deliver() must never throw — report, don't crash. */
export interface IReceiptSink {
  readonly name: string;
  deliver(receipt: IChainHeadReceipt): Promise<IReceiptDeliveryOutcome>;
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Build a chain-head receipt. Pure and strict: a malformed receipt is worse
 * than no receipt (a witness holding garbage attests to nothing), so invalid
 * inputs throw rather than degrade.
 */
export function buildChainHeadReceipt(input: {
  instanceId: string;
  headHash: string;
  chainIndex: number;
}): IChainHeadReceipt {
  if (!input.instanceId?.trim()) {
    throw new Error('receipt requires a non-empty instanceId');
  }
  if (!SHA256_HEX.test(input.headHash)) {
    throw new Error('receipt headHash must be a 64-char SHA-256 hex string');
  }
  if (!Number.isInteger(input.chainIndex) || input.chainIndex < 0) {
    throw new Error('receipt chainIndex must be a non-negative integer');
  }
  return {
    receiptVersion: 1,
    instanceId: input.instanceId.trim(),
    headHash: input.headHash,
    chainIndex: input.chainIndex,
    generatedAt: new Date().toISOString(),
  };
}

/** Default sink until a real counterparty is configured — reports, never throws. */
export class NullReceiptSink implements IReceiptSink {
  readonly name = 'null';
  async deliver(_receipt: IChainHeadReceipt): Promise<IReceiptDeliveryOutcome> {
    return { delivered: false, reason: 'NOT_CONFIGURED' };
  }
}

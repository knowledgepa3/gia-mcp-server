/**
 * @module    shared-utils
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { v4 as uuidv4 } from 'uuid';
import { MAX_INPUT_LENGTH } from './constants.js';

export function generateAuditId(): string { return uuidv4(); }
export function generateGateId(): string { return `gate-${uuidv4()}`; }

export function sanitize(input: string, maxLength: number = MAX_INPUT_LENGTH): string {
  // Enforce hard length cap before any processing — prevents regex DoS on unbounded input
  const bounded = input.length > maxLength ? input.slice(0, maxLength) : input;
  return bounded
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

export function detectPii(text: string): boolean {
  const patterns = [
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b\d{2}\/\d{2}\/\d{4}\b/,
    /\b\d{4}-\d{2}-\d{2}\b/,
  ];
  return patterns.some(p => p.test(text));
}

export function redactPii(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN-REDACTED]')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, '[DATE-REDACTED]');
}

export function utcNow(): Date { return new Date(); }

export function durationMs(start: Date, end: Date): number {
  return end.getTime() - start.getTime();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function truncateMetadata(
  metadata: Record<string, unknown>, maxBytes: number
): Record<string, unknown> {
  const serialized = JSON.stringify(metadata);
  if (serialized.length <= maxBytes) return metadata;
  return {
    _truncated: true, _originalSize: serialized.length,
    ...Object.fromEntries(Object.entries(metadata).slice(0, 5)),
  };
}

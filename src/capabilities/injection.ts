import {
  PromptInjectionSignalCode,
  UntrustedObservation,
} from './types';
import { sha256Text } from './hash';

export interface PromptInjectionSignal {
  code: PromptInjectionSignalCode;
  severity: 'medium' | 'high';
}

export interface PromptInjectionAssessment {
  risk: 'none' | 'medium' | 'high';
  signals: PromptInjectionSignal[];
  contentHash: string;
  scannedChars: number;
  truncated: boolean;
}

export const severityForSignal = (code: PromptInjectionSignalCode): 'medium' | 'high' => (
  code === 'tool_execution_request' ? 'medium' : 'high'
);

const MAX_SCAN_CHARS = 64 * 1024;
const signalRules: Array<{ code: PromptInjectionSignalCode; severity: 'medium' | 'high'; pattern: RegExp }> = [
  { code: 'instruction_override', severity: 'high', pattern: /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|prior|system|developer)\b.{0,20}\binstructions?\b/isu },
  { code: 'secret_request', severity: 'high', pattern: /\b(?:reveal|show|print|send|extract|read)\b.{0,40}\b(?:api[ _-]?key|password|secret|credential|access[ _-]?token)\b/isu },
  { code: 'authority_bypass', severity: 'high', pattern: /\b(?:bypass|skip|disable|evade)\b.{0,30}\b(?:approval|permission|policy|authorization|safety)\b/isu },
  { code: 'exfiltration_request', severity: 'high', pattern: /\b(?:upload|exfiltrate|transmit|send)\b.{0,50}\b(?:secret|credential|token|key|data|it)\b/isu },
  { code: 'tool_execution_request', severity: 'medium', pattern: /\b(?:run|execute|invoke)\b.{0,30}\b(?:shell|command|tool|script)\b/isu },
];

export const analyzePromptInjection = (content: string): PromptInjectionAssessment => {
  const scanned = content.slice(0, MAX_SCAN_CHARS);
  const signals = signalRules
    .filter((rule) => rule.pattern.test(scanned))
    .map(({ code, severity }) => ({ code, severity }));
  const risk = signals.length === 0
    ? 'none'
    : signals.some((item) => item.severity === 'high') || signals.length > 1 ? 'high' : 'medium';
  return {
    risk,
    signals,
    contentHash: sha256Text(content),
    scannedChars: scanned.length,
    truncated: content.length > scanned.length,
  };
};

export interface CreateObservationInput {
  id: string;
  source: UntrustedObservation['source'];
  sourceRef: string;
  content: string;
  capturedAt: string;
}

export const createUntrustedObservation = (input: CreateObservationInput): UntrustedObservation => {
  const assessment = analyzePromptInjection(input.content);
  return {
    id: input.id,
    source: input.source,
    sourceRef: input.sourceRef,
    contentHash: assessment.contentHash,
    capturedAt: input.capturedAt,
    canGrantAuthority: false,
    injectionSignalCodes: assessment.signals.map((item) => item.code),
  };
};

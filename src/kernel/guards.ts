import { AutonomyLevel, GoalContractInput, KernelBudget, KernelCommandRequest, RiskLevel } from './types';

const riskLevels = new Set<RiskLevel>(['L0', 'L1', 'L2', 'L3', 'L4']);
const autonomyLevels = new Set<AutonomyLevel>(['manual', 'supervised', 'bounded']);
const allowedCommands = new Set(['npm']);
const allowedNpmScripts = new Set(['test', 'run lint', 'run build']);
const allowedVerificationCommands = new Set(['npm test', 'npm run lint', 'npm run build']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0);
};

const isNonNegativeSafeInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
};

export const isRiskLevel = (value: unknown): value is RiskLevel => {
  return typeof value === 'string' && riskLevels.has(value as RiskLevel);
};

export const isKernelBudget = (value: unknown): value is KernelBudget => {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeSafeInteger(value.maxOperations) &&
    value.maxOperations > 0 &&
    isNonNegativeSafeInteger(value.maxCommandRuntimeMs) &&
    value.maxCommandRuntimeMs > 0 &&
    isNonNegativeSafeInteger(value.maxApprovals) &&
    isNonNegativeSafeInteger(value.maxProviderCalls)
  );
};

export const isGoalContractInput = (value: unknown): value is GoalContractInput => {
  if (!isRecord(value)) return false;
  return (
    typeof value.objective === 'string' &&
    value.objective.trim().length >= 3 &&
    isStringArray(value.successCriteria) &&
    isStringArray(value.constraints) &&
    typeof value.autonomyLevel === 'string' &&
    autonomyLevels.has(value.autonomyLevel as AutonomyLevel) &&
    typeof value.workspaceRoot === 'string' &&
    value.workspaceRoot.trim().length > 0 &&
    isStringArray(value.verificationCommands) &&
    value.verificationCommands.every((command) => allowedVerificationCommands.has(command)) &&
    isKernelBudget(value.budget)
  );
};

export const isKernelCommandRequest = (value: unknown): value is KernelCommandRequest => {
  if (!isRecord(value)) return false;
  if (value.command !== 'npm') return false;
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) return false;
  const script = value.args.join(' ');
  return (
    allowedCommands.has(value.command) &&
    allowedNpmScripts.has(script) &&
    typeof value.cwd === 'string' &&
    value.cwd.trim().length > 0 &&
    typeof value.expectedEvidence === 'string' &&
    value.expectedEvidence.trim().length > 0
  );
};

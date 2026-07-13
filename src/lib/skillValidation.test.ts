import { describe, expect, it } from 'vitest';
import { AgentSkill } from '../types';
import { validateSkillSnippet, withValidationResult } from './skillValidation';

const skill = (codeSnippet: string): AgentSkill => ({
  id: 'skill_1',
  name: 'ExampleSkill',
  description: 'Example deterministic skill',
  codeSnippet,
  capabilities: ['Example capability'],
  successCount: 0,
  failureCount: 0,
  lastRunStatus: 'untested',
  createdAt: '2026-06-21T00:00:00.000Z',
});

describe('skill validation', () => {
  it('passes when a snippet exports an execute function and contains no forbidden dynamic evaluation', () => {
    const result = validateSkillSnippet(skill('export function execute(input) { return input; }'));
    expect(result.status).toBe('passed');
    expect(result.messages).toEqual(['Found exported execute function.']);
  });

  it('fails when the execute function is missing', () => {
    const result = validateSkillSnippet(skill('export const value = 1;'));
    expect(result.status).toBe('failed');
    expect(result.messages).toContain('Missing exported execute function.');
  });

  it('fails when a snippet uses dynamic evaluation or network access', () => {
    const result = validateSkillSnippet(skill('export function execute() { return eval("1 + 1"); }'));
    expect(result.status).toBe('failed');
    expect(result.messages).toContain('Contains blocked token: eval(');
  });

  it('records deterministic validation counters', () => {
    const updated = withValidationResult(skill('export const value = 1;'));
    expect(updated.lastRunStatus).toBe('failed');
    expect(updated.failureCount).toBe(1);
    expect(updated.successCount).toBe(0);
  });
});

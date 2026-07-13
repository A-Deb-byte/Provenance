import { AgentSkill, SkillValidationResult } from '../types';

const blockedTokens = ['eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'localStorage', 'document.cookie'];

export const validateSkillSnippet = (skill: Pick<AgentSkill, 'codeSnippet'>): SkillValidationResult => {
  const messages: string[] = [];
  const code = skill.codeSnippet;

  if (!/export\s+function\s+execute\s*\(/.test(code)) {
    messages.push('Missing exported execute function.');
  } else {
    messages.push('Found exported execute function.');
  }

  for (const token of blockedTokens) {
    if (code.includes(token)) {
      messages.push(`Contains blocked token: ${token}`);
    }
  }

  const hasFailure = messages.some((message) =>
    message.startsWith('Missing') || message.startsWith('Contains blocked token'),
  );

  return {
    status: hasFailure ? 'failed' : 'passed',
    messages,
  };
};

export const withValidationResult = (skill: AgentSkill): AgentSkill => {
  const result = validateSkillSnippet(skill);

  return {
    ...skill,
    successCount: result.status === 'passed' ? skill.successCount + 1 : skill.successCount,
    failureCount: result.status === 'failed' ? skill.failureCount + 1 : skill.failureCount,
    lastRunStatus: result.status,
  };
};

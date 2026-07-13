import { describe, expect, it } from 'vitest';
import { decidePolicyForCommand, decidePolicyForRisk } from './policy';

describe('kernel policy', () => {
  it('allows L0 and L1 under policy', () => {
    expect(decidePolicyForRisk('L0').kind).toBe('allow');
    expect(decidePolicyForRisk('L1').kind).toBe('allow');
  });

  it('requires approval for L2 and L3', () => {
    expect(decidePolicyForRisk('L2').kind).toBe('approval_required');
    expect(decidePolicyForRisk('L3').kind).toBe('approval_required');
  });

  it('denies L4 and unapproved commands', () => {
    expect(decidePolicyForRisk('L4').kind).toBe('deny');
    expect(decidePolicyForCommand({ command: 'powershell', args: ['Remove-Item'], cwd: '.', expectedEvidence: 'none' }).kind).toBe('deny');
  });
});

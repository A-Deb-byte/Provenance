import { describe, expect, it } from 'vitest';
import { SkillCase } from '../types';
import { synthesizePureTransform } from './synthesizer';

const trainCase = (id: string, input: string, expectedOutput: string): SkillCase => ({
  id,
  input,
  expectedOutput,
  kind: 'train',
});

describe('pure transform synthesizer', () => {
  it('enumerates bounded programs and finds a strict improvement over identity', () => {
    const result = synthesizePureTransform([
      trainCase('case_b', '  MIXED\t Case ', 'mixed case'),
      trainCase('case_a', '  HELLO   WORLD ', 'hello world'),
    ]);

    expect(result.program.steps.map((step) => step.operation)).toEqual([
      'trim',
      'collapse_whitespace',
      'lowercase',
    ]);
    expect(result.candidateScore).toBe(1);
    expect(result.baselineScore).toBe(0);
    expect(result.improvesBaseline).toBe(true);
    expect(result.trainingResults.map((item) => item.caseId)).toEqual(['case_a', 'case_b']);
    expect(result.programsEvaluated).toBeGreaterThan(1);
  });

  it('uses shortest program then fixed operation order as the tie-break', () => {
    const result = synthesizePureTransform([
      trainCase('case_1', 'ALREADY', 'already'),
    ], { maxSteps: 4 });

    expect(result.program.steps).toEqual([{ operation: 'lowercase' }]);
  });

  it('returns identity when no candidate can beat the baseline', () => {
    const result = synthesizePureTransform([
      trainCase('case_1', 'already correct', 'already correct'),
    ]);

    expect(result.program.steps).toEqual([]);
    expect(result.candidateScore).toBe(1);
    expect(result.baselineScore).toBe(1);
    expect(result.improvesBaseline).toBe(false);
  });

  it('is independent of training-case order', () => {
    const cases = [
      trainCase('case_a', '  A  ', 'a'),
      trainCase('case_b', '  B  ', 'b'),
    ];

    expect(synthesizePureTransform(cases).program)
      .toEqual(synthesizePureTransform([...cases].reverse()).program);
  });

  it('rejects replay cases, duplicate ids, and oversized suites', () => {
    expect(() => synthesizePureTransform([{ ...trainCase('case_1', 'a', 'a'), kind: 'replay' }]))
      .toThrow('training cases');
    expect(() => synthesizePureTransform([
      trainCase('same', 'a', 'a'),
      trainCase('same', 'b', 'b'),
    ])).toThrow('unique');
    expect(() => synthesizePureTransform(
      Array.from({ length: 33 }, (_, index) => trainCase(`case_${index}`, 'a', 'a')),
    )).toThrow('at most 32');
  });
});

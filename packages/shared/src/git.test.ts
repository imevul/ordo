import { describe, expect, it } from 'vitest';
import { branchName, defaultGitAutomation, gitAutomationTarget } from './git.ts';

const states = [
  { id: 'b', name: 'Backlog', type: 'backlog' as const, position: 0 },
  { id: 'p', name: 'In Progress', type: 'started' as const, position: 1 },
  { id: 'r', name: 'In Review', type: 'started' as const, position: 2 },
  { id: 'd', name: 'Done', type: 'completed' as const, position: 3 },
];

describe('branchName', () => {
  it('follows the format', () => {
    expect(
      branchName('{username}/{identifier}-{title}', {
        identifier: 'ENG-42',
        title: 'Fix the flux capacitor!',
        username: 'Ada L',
      }),
    ).toBe('ada-l/eng-42-fix-the-flux-capacitor');
    expect(branchName('{identifier}', { identifier: 'ENG-1', title: 'x', username: '' })).toBe(
      'eng-1',
    );
    expect(
      branchName('{username}/{identifier}', { identifier: 'ENG-1', title: '', username: '' }),
    ).toBe('eng-1');
    expect(
      branchName('{identifier}-{title}', {
        identifier: 'OPS-7',
        title: 'Crème brûlée',
        username: '',
      }),
    ).toBe('ops-7-creme-brulee');
  });
});

describe('git automation', () => {
  it('has sensible defaults and honours overrides', () => {
    expect(defaultGitAutomation(states)).toEqual({
      branch: null,
      draft: 'p',
      open: 'p',
      review: 'r',
      merged: 'd',
    });
    expect(gitAutomationTarget({ open: 'none' }, states, 'open')).toBeNull();
    expect(gitAutomationTarget({ open: 'r' }, states, 'open')).toBe('r');
    expect(gitAutomationTarget({ open: 'gone' }, states, 'open')).toBe('p');
  });
});

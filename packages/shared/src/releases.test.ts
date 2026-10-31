import { describe, expect, it } from 'vitest';
import { draftReleaseNotes, releaseMarkdown } from './releases.ts';

const labels = [
  { id: 'f', name: 'Feature' },
  { id: 'b', name: 'Bug' },
  { id: 'u', name: 'UI' },
];

describe('draftReleaseNotes', () => {
  it('groups by label, largest section first, unlabelled last', () => {
    const notes = draftReleaseNotes(
      [
        { identifier: 'ENG-1', title: 'Dark mode', labelIds: ['f'] },
        { identifier: 'ENG-2', title: 'Crash on save ', labelIds: ['b'] },
        { identifier: 'ENG-3', title: 'Releases', labelIds: ['f', 'u'] },
        { identifier: 'ENG-4', title: 'Tidy up', labelIds: [] },
        { identifier: 'ENG-5', title: 'Gone label', labelIds: ['deleted'] },
      ],
      labels,
      'Other',
    );
    expect(notes).toBe(
      [
        '## Feature',
        '',
        '- Dark mode (ENG-1)',
        '- Releases (ENG-3)',
        '',
        '## Bug',
        '',
        '- Crash on save (ENG-2)',
        '',
        '## Other',
        '',
        '- Tidy up (ENG-4)',
        '- Gone label (ENG-5)',
      ].join('\n'),
    );
  });

  it('breaks ties by label name', () => {
    const notes = draftReleaseNotes(
      [
        { identifier: 'A-1', title: 'One', labelIds: ['u'] },
        { identifier: 'A-2', title: 'Two', labelIds: ['b'] },
      ],
      labels,
      'Other',
    );
    expect(notes.indexOf('## Bug')).toBeLessThan(notes.indexOf('## UI'));
  });

  it('is empty without issues', () => {
    expect(draftReleaseNotes([], labels, 'Other')).toBe('');
  });
});

describe('releaseMarkdown', () => {
  it('heads the notes with the name and release date', () => {
    expect(
      releaseMarkdown({
        name: 'v0.2',
        notes: '## Feature\n\n- X (A-1)\n',
        releasedAt: '2026-10-31T12:00:00.000Z',
        targetDate: '2026-11-05',
      }),
    ).toBe('# v0.2 (2026-10-31)\n\n## Feature\n\n- X (A-1)\n');
    expect(releaseMarkdown({ name: 'v1', notes: '', releasedAt: null, targetDate: null })).toBe(
      '# v1\n',
    );
  });
});

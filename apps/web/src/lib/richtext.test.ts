import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { richTextUnsafe } from './markdown.ts';
import { escapeMarkdownText, markdownConverter, richTextExtensions } from './richtext.ts';

const md = markdownConverter();
const schema = getSchema(richTextExtensions());
const roundTrip = (s: string) => md.serialize(md.parse(s));

describe('markdown round trip', () => {
  test.each([
    '# Title',
    'Some **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.com).',
    'ENG-12 was reported by @alice in snake_case_names, 2 * 3 * 4 and R&D <3',
    '- one\n- two\n  - nested',
    '1. first\n2. second',
    '- [ ] todo\n- [x] done',
    '> quoted',
    '```ts\nconst a = 1;\n\n\n// gap\n```',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '![shot.png](/api/attachments/abc)',
    'See [report.pdf](/api/attachments/def) and [ENG-3](/demo/issue/ENG-3).',
    'Text with ![inline.png](/api/attachments/x) image',
    '> ![quoted.png](/api/attachments/q)',
    '- ![listed.png](/api/attachments/l)',
    'Line one\nline two',
    '---',
  ])('%s', (source) => {
    // Formatting may be normalised (emphasis markers, table padding) but must read back the same.
    // The editor only loads documents its schema accepts.
    expect(() => schema.nodeFromJSON(md.parse(source)).check()).not.toThrow();
    const once = roundTrip(source);
    expect(roundTrip(once)).toBe(once);
    expect(md.parse(once)).toEqual(md.parse(source));
  });

  test('keeps plain text free of needless escapes', () => {
    expect(roundTrip('snake_case and 2 * 3, R&D, a < b > c, C:\\Users')).toBe(
      'snake_case and 2 * 3, R&D, a < b > c, C:\\Users',
    );
  });

  test('drops blank paragraphs instead of writing &nbsp;', () => {
    const doc = md.parse('one\n\ntwo');
    doc.content?.splice(1, 0, { type: 'paragraph' }, { type: 'paragraph' });
    expect(md.serialize(doc)).toBe('one\n\ntwo');
    expect(md.serialize({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('');
  });

  test('keeps table cells and pipes apart', () => {
    const out = roundTrip('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |');
    expect(md.parse(out)).toEqual(md.parse('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |'));
  });
});

describe('escapeMarkdownText', () => {
  test.each([
    ['*not bold*', '\\*not bold\\*'],
    ['_not italic_', '\\_not italic\\_'],
    ['[not a link](x)', '\\[not a link\\](x)'],
    ['# not a heading', '\\# not a heading'],
    ['- not a list', '\\- not a list'],
    ['1. not a list', '1\\. not a list'],
    ['> not a quote', '\\> not a quote'],
    ['&amp; literally', '&amp;amp; literally'],
    ['<div> literally', '&lt;div> literally'],
    ['`tick`', '\\`tick\\`'],
  ])('%s', (text, escaped) => {
    expect(escapeMarkdownText(text)).toBe(escaped);
    const doc = md.parse(escaped);
    expect(doc.content?.[0]?.content?.[0]?.text).toBe(text);
  });
});

test('richTextUnsafe flags HTML and footnotes outside code', () => {
  expect(richTextUnsafe('hello <details>x</details>')).toBe(true);
  expect(richTextUnsafe('see [^1]\n\n[^1]: note')).toBe(true);
  expect(richTextUnsafe('use `<div>` here')).toBe(false);
  expect(richTextUnsafe('a < b and b > c')).toBe(false);
  expect(richTextUnsafe('```html\n<div></div>\n```')).toBe(false);
});

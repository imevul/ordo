import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { richTextUnsafe } from './markdown.ts';
import { escapeMarkdownText, markdownConverter, richTextExtensions } from './richtext.ts';

const md = markdownConverter();
const schema = getSchema(richTextExtensions());
const roundTrip = (s: string) => md.serialize(md.parse(s));
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

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

  // The round trip above compares the converter with itself; these pin what it actually builds.
  test('parses task lists into checked and unchecked task items', () => {
    expect(md.parse('- [ ] todo\n- [x] done')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [paragraph('todo')] },
            { type: 'taskItem', attrs: { checked: true }, content: [paragraph('done')] },
          ],
        },
      ],
    });
  });

  test('parses tables into a header row and body cells', () => {
    const cell = (type: string, text: string) => ({ type, content: [paragraph(text)] });
    expect(md.parse('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'a'), cell('tableHeader', 'b')] },
            { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] },
          ],
        },
      ],
    });
  });

  test('parses images as inline image nodes with their source and alt text', () => {
    expect(md.parse('Text with ![inline.png](/api/attachments/x) image').content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Text with ' },
          { type: 'image', attrs: { src: '/api/attachments/x', alt: 'inline.png', title: null } },
          { type: 'text', text: ' image' },
        ],
      },
    ]);
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

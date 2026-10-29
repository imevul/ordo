import { describe, expect, it } from 'vitest';
import { jiraToMarkdown, markdownToJira } from '../src/services/imports/jira-markup.ts';

describe('jiraToMarkdown', () => {
  it('converts headings, emphasis, monospace and links', () => {
    expect(
      jiraToMarkdown(
        'h2. Steps\nRun *only* {{npm *test*}} -not that- and see [the docs|https://x.test/d] or [https://x.test].',
      ),
    ).toBe(
      '## Steps\nRun **only** `npm *test*` ~~not that~~ and see [the docs](https://x.test/d) or <https://x.test>.',
    );
  });

  it('leaves hyphens and stars inside words alone', () => {
    expect(jiraToMarkdown('A well-known 2*3*4 sign-off')).toBe('A well-known 2*3*4 sign-off');
  });

  it('converts lists, quotes and rules', () => {
    expect(jiraToMarkdown('* one\n** nested\n# first\n## inner\n----\nbq. quoted')).toBe(
      '- one\n   - nested\n1. first\n   1. inner\n---\n> quoted',
    );
    expect(jiraToMarkdown('{quote}\nSaid *this*\n{quote}\nAfter')).toBe('> Said **this**\nAfter');
  });

  it('keeps code blocks as they are', () => {
    expect(jiraToMarkdown('{code:java}\nint *x* = 1;\n{code}\ndone')).toBe(
      '```java\nint *x* = 1;\n```\ndone',
    );
    expect(jiraToMarkdown('{noformat}raw *text*{noformat}')).toBe('```\nraw *text*\n```');
  });

  it('converts tables, mentions, images and colours', () => {
    expect(jiraToMarkdown('||Name||Link||\n|a|[site|https://s.test]|')).toBe(
      '| Name | Link |\n| --- | --- |\n| a | [site](https://s.test) |',
    );
    expect(
      jiraToMarkdown('[~bob] and [~accountid:5b10] see !shot.png|thumbnail! {color:red}now{color}'),
    ).toBe('@bob and @someone see (shot.png) now');
  });
});

describe('markdownToJira', () => {
  it('converts what jiraToMarkdown reads back', () => {
    const md = [
      '# Title',
      'Some **bold**, *italic*, ~~gone~~ and `code *here*`.',
      'See [the docs](https://d.test/x) or <https://s.test>.',
      '- one',
      '  - nested',
      '1. first',
      '> quoted',
      '---',
      '```ts',
      'const a = **b**;',
      '```',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const wiki = markdownToJira(md);
    expect(wiki).toBe(
      [
        'h1. Title',
        'Some *bold*, _italic_, -gone- and {{code *here*}}.',
        'See [the docs|https://d.test/x] or [https://s.test].',
        '* one',
        '** nested',
        '# first',
        'bq. quoted',
        '----',
        '{code:ts}',
        'const a = **b**;',
        '{code}',
        '||A||B||',
        '|1|2|',
      ].join('\n'),
    );
    expect(jiraToMarkdown(wiki)).toContain('Some **bold**');
    expect(jiraToMarkdown(wiki)).toContain('[the docs](https://d.test/x)');
  });
});

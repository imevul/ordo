import { describe, expect, it } from 'vitest';
import { jiraToMarkdown } from '../src/services/imports/jira-markup.ts';

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

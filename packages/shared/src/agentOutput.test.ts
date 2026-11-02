import { describe, expect, it } from 'vitest';
import {
  agentSessionId,
  appendOutput,
  cleanOutputLine,
  describeAgentEvent,
  outputMarkdown,
  parseOutputLine,
} from './agentOutput.ts';
import {
  AGENT_OUTPUT_BYTES,
  AGENT_OUTPUT_LINE_CHARS,
  AGENT_OUTPUT_LINES,
  AGENT_OUTPUT_PICKUP,
} from './constants.ts';

describe('cleanOutputLine', () => {
  it('drops terminal escapes and control characters', () => {
    expect(cleanOutputLine('\x1b[32m✓\x1b[0m passed\x07')).toBe('✓ passed');
    expect(cleanOutputLine('\x1b]0;title\x07done')).toBe('done');
    expect(cleanOutputLine('a\tb\x00c')).toBe('a\tbc');
  });

  it('keeps what the last carriage return left, as a terminal shows it', () => {
    expect(cleanOutputLine('10%\r50%\r100%')).toBe('100%');
    expect(cleanOutputLine('windows line\r')).toBe('windows line');
  });

  it('cuts long lines short', () => {
    const out = cleanOutputLine('x'.repeat(5000));
    expect(out).toHaveLength(AGENT_OUTPUT_LINE_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('appendOutput', () => {
  it('keeps the last lines', () => {
    const lines = Array.from({ length: AGENT_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`);
    const kept = appendOutput(['old'], lines);
    expect(kept).toHaveLength(AGENT_OUTPUT_LINES);
    expect(kept.at(-1)).toBe(`line ${AGENT_OUTPUT_LINES + 49}`);
    expect(kept[0]).toBe('line 50');
  });

  it('keeps no more than its bytes', () => {
    const wide = Array.from({ length: AGENT_OUTPUT_LINES }, () => 'é'.repeat(900));
    const kept = appendOutput([], wide);
    // 'é' is two bytes in UTF-8.
    const bytes = kept.reduce((n, l) => n + l.length * 2 + 1, 0);
    expect(bytes).toBeLessThanOrEqual(AGENT_OUTPUT_BYTES);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(AGENT_OUTPUT_LINES);
  });
});

describe('describeAgentEvent', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('shows what Claude Code said and which tools it called', () => {
    expect(
      describeAgentEvent(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Running the tests.\n\nThen lint.' },
              { type: 'tool_use', name: 'Bash', input: { command: 'pnpm  test\n--run' } },
              { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
            ],
          },
        }),
      ),
    ).toEqual([
      'Running the tests.',
      'Then lint.',
      '→ Bash: pnpm test --run',
      '→ TodoWrite: todos: []',
    ]);
    expect(describeAgentEvent(line({ type: 'system', subtype: 'init' }))).toEqual([
      'Session started',
    ]);
  });

  const result = (content: unknown, isError?: boolean) =>
    describeAgentEvent(
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't', content, is_error: isError }],
        },
      }),
    );

  it('shows how a tool result starts, indented, and says how much it left out', () => {
    expect(result('one\n\ntwo\n')).toEqual(['  one', '  two']);
    expect(result([{ type: 'text', text: 'from a block' }, { type: 'image' }])).toEqual([
      '  from a block',
    ]);
    const six = 'a\nb\nc\nd\ne\nf';
    expect(result(six)).toEqual(['  a', '  b', '  c', '  d', '  e', '  … 1 more line']);
    expect(result(`${six}\ng`)?.at(-1)).toBe('  … 2 more lines');
    expect(result('')).toEqual([]);
  });

  it('marks a failed tool result', () => {
    expect(result('old_string not found\nin the file', true)).toEqual([
      '✗ old_string not found',
      '  in the file',
    ]);
    expect(result('', true)).toEqual(['✗ The tool failed']);
  });

  it('skips the final result and bookkeeping, and leaves other lines alone', () => {
    expect(describeAgentEvent(line({ type: 'user', message: { content: [] } }))).toEqual([]);
    expect(
      describeAgentEvent(
        line({ type: 'user', message: { content: [{ type: 'text', text: 'The prompt' }] } }),
      ),
    ).toEqual([]);
    expect(describeAgentEvent(line({ type: 'result', result: 'Done' }))).toEqual([]);
    expect(describeAgentEvent('plain output')).toBeNull();
    expect(describeAgentEvent('{"level":"info"}')).toBeNull();
    expect(describeAgentEvent('{not json}')).toBeNull();
  });
});

describe('agentSessionId', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("reads the session from Claude Code's first and last events", () => {
    expect(agentSessionId(line({ type: 'system', subtype: 'init', session_id: 'abc' }))).toBe(
      'abc',
    );
    expect(agentSessionId(line({ type: 'result', result: 'Done', session_id: 'abc' }))).toBe('abc');
  });

  it('ignores everything else', () => {
    expect(agentSessionId(line({ type: 'assistant', session_id: 'abc' }))).toBeNull();
    expect(agentSessionId(line({ session_id: 'abc' }))).toBeNull();
    expect(agentSessionId(line({ type: 'result', session_id: 5 }))).toBeNull();
    expect(agentSessionId('session_id abc')).toBeNull();
    expect(agentSessionId('{"session_id": not json}')).toBeNull();
  });
});

describe('tool calls in the output', () => {
  const call = (name: string, input: unknown) =>
    describeAgentEvent(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name, input }] },
      }),
    );

  it('says what a call is about, or its fields, rather than its JSON', () => {
    expect(
      call('mcp__ordo__report_progress', { run: 'abc', step: 'Merging', percent: 85 }),
    ).toEqual(['→ mcp__ordo__report_progress: Merging']);
    expect(
      call('mcp__ordo__add_comment', { issue: 'ENG-1', body: '**First**\n\n## Second\na *b' }),
    ).toEqual(['→ mcp__ordo__add_comment: First Second a *b']);
    expect(call('Bash', { command: 'ls **/*.ts # all' })).toEqual(['→ Bash: ls **/*.ts # all']);
    expect(call('mcp__ordo__get_issue', { issue: 'ENG-1', comments: false })).toEqual([
      '→ mcp__ordo__get_issue: issue: ENG-1 · comments: false',
    ]);
  });

  it('reads lines back by kind', () => {
    expect(parseOutputLine(AGENT_OUTPUT_PICKUP)).toEqual({ kind: 'pickup' });
    expect(parseOutputLine('Session started')).toEqual({ kind: 'session' });
    expect(parseOutputLine('  FAIL a.test.ts')).toEqual({ kind: 'result', text: 'FAIL a.test.ts' });
    expect(parseOutputLine('✗ not found')).toEqual({ kind: 'error', text: 'not found' });
    expect(parseOutputLine('Plain words: here')).toEqual({
      kind: 'text',
      text: 'Plain words: here',
    });
    expect(parseOutputLine('→ Bash: pnpm test')).toEqual({
      kind: 'tool',
      tool: 'Bash',
      server: null,
      detail: 'pnpm test',
    });
    expect(parseOutputLine('→ TodoRead')).toEqual({
      kind: 'tool',
      tool: 'TodoRead',
      server: null,
      detail: '',
    });
    expect(parseOutputLine('→ mcp__ordo__update_issue: issue: ENG-1')).toMatchObject({
      tool: 'update_issue',
      server: 'ordo',
    });
  });

  it('summarises the JSON of lines written before gists, unless it was cut short', () => {
    expect(
      parseOutputLine('→ mcp__ordo__update_issue: {"issue":"ENG-1","status":"Done"}'),
    ).toMatchObject({ detail: 'issue: ENG-1 · status: Done' });
    expect(parseOutputLine('→ mcp__ordo__add_comment: {"body":"cut sho…')).toMatchObject({
      detail: '{"body":"cut sho…',
    });
  });
});

describe('outputMarkdown', () => {
  it('makes each line a paragraph of its own', () => {
    expect(outputMarkdown(['One.', 'Two.'])).toBe('One.\n\nTwo.');
  });

  it('keeps lists, tables and code together', () => {
    expect(outputMarkdown(['Then:', '- a', '- b', 'Done.'])).toBe('Then:\n\n- a\n- b\n\nDone.');
    expect(outputMarkdown(['| a |', '|---|', '| 1 |'])).toBe('| a |\n|---|\n| 1 |');
    expect(outputMarkdown(['```sh', 'one', 'two', '```', 'After.'])).toBe(
      '```sh\none\ntwo\n```\n\nAfter.',
    );
  });
});

import {
  AGENT_OUTPUT_BYTES,
  AGENT_OUTPUT_LINE_CHARS,
  AGENT_OUTPUT_LINES,
  AGENT_OUTPUT_PICKUP,
  AGENT_OUTPUT_RESULT_LINES,
} from './constants.ts';

// Colour codes, cursor moves and terminal titles: CSI (`ESC [ … letter`) and OSC (`ESC ] … BEL`).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: what's left of the control characters
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Bytes `s` takes in UTF-8 (shared code has neither `Buffer` nor `TextEncoder`). */
function utf8Length(s: string) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * A line of output as a page can show it: without terminal escapes, only what a progress bar's
 * last `\r` left, no other control characters, and cut short at `AGENT_OUTPUT_LINE_CHARS`.
 */
export function cleanOutputLine(line: string): string {
  let s = line.replace(ESCAPES, '');
  const cr = s.replace(/\r+$/, '').lastIndexOf('\r');
  if (cr >= 0) s = s.slice(cr + 1);
  s = s.replace(CONTROLS, '').trimEnd();
  return s.length > AGENT_OUTPUT_LINE_CHARS ? `${s.slice(0, AGENT_OUTPUT_LINE_CHARS - 1)}…` : s;
}

/** `lines` added to the tail `kept`, cleaned, then capped to the last lines and bytes Ordo keeps. */
export function appendOutput(kept: string[], lines: string[]): string[] {
  const next = [...kept, ...lines.map(cleanOutputLine)].slice(-AGENT_OUTPUT_LINES);
  const sizes = next.map((l) => utf8Length(l) + 1);
  let bytes = sizes.reduce((a, b) => a + b, 0);
  let start = 0;
  while (bytes > AGENT_OUTPUT_BYTES) bytes -= sizes[start++]!;
  return next.slice(start);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The input that says what a tool call is about, for tools that have one. */
const GIST_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'step',
  'question',
  'plan',
  'body',
  'title',
];

/** Inputs written in Markdown, whose bold and headings are only noise on one line. */
const MARKDOWN_KEYS = new Set(['question', 'plan', 'body']);
const plainText = (s: string) => s.replace(/\*\*|(^|\s)#{1,6} /g, '$1');

/**
 * The gist of a tool call's input: its command, path, pattern or URL, else its other fields as
 * `issue: ENG-1 · status: Done`, since JSON is hard to read at a glance.
 */
function toolGist(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of GIST_KEYS) {
    const v = o[key];
    if (typeof v === 'string' && v.trim())
      return MARKDOWN_KEYS.has(key) ? plainText(oneLine(v)) : oneLine(v);
  }
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? oneLine(v) : JSON.stringify(v)}`)
    .join(' · ');
}

/** A tool result's text: Claude Code sends a string, or text blocks among others (images). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: unknown; text?: unknown }[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The start of a tool result, indented under its call: enough to see why a command failed, and
 * little of what it read, which is often whole files. An error's first line says `✗`.
 */
function describeResult(block: { content?: unknown; is_error?: unknown }): string[] {
  const lines = resultText(block.content)
    .split('\n')
    .filter((l) => l.trim());
  const shown = lines.slice(0, AGENT_OUTPUT_RESULT_LINES).map((l) => `  ${l}`);
  if (block.is_error === true) {
    const first = lines[0]?.trim() ?? 'The tool failed';
    shown[0] = `✗ ${first}`;
  }
  const more = lines.length - AGENT_OUTPUT_RESULT_LINES;
  if (more > 0) shown.push(more === 1 ? '  … 1 more line' : `  … ${more} more lines`);
  return shown;
}

/**
 * Readable lines for one line of Claude Code's `--output-format stream-json`: what the assistant
 * said, which tools it called (`→ Bash: pnpm test`) and how each result starts. Bookkeeping events
 * give none. Null when the line isn't such an event, so it's shown as printed.
 */
export function describeAgentEvent(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let event: { type?: unknown; subtype?: unknown; message?: { content?: unknown } };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
  switch (event.type) {
    case 'assistant': {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      const out: string[] = [];
      for (const block of content as { type?: string; text?: unknown; name?: unknown }[]) {
        if (block.type === 'text' && typeof block.text === 'string')
          out.push(...block.text.split('\n').filter((l) => l.trim()));
        else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const gist = toolGist((block as { input?: unknown }).input);
          out.push(`→ ${block.name}${gist ? `: ${gist}` : ''}`);
        }
      }
      return out;
    }
    case 'system':
      return event.subtype === 'init' ? ['Session started'] : [];
    case 'user': {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      return (content as { type?: string; content?: unknown; is_error?: unknown }[]).flatMap((b) =>
        b.type === 'tool_result' ? describeResult(b) : [],
      );
    }
    case 'result':
    case 'stream_event':
      return [];
    default:
      return null;
  }
}

/**
 * The session a line of Claude Code's `stream-json` belongs to, so a later pickup can continue it
 * without a wrapper script printing `ORDO_RESUME=`. Null for any other line.
 */
export function agentSessionId(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"session_id"')) return null;
  try {
    const event = JSON.parse(trimmed) as {
      type?: unknown;
      subtype?: unknown;
      session_id?: unknown;
    };
    const named = (event.type === 'system' && event.subtype === 'init') || event.type === 'result';
    return named && typeof event.session_id === 'string' && event.session_id
      ? event.session_id
      : null;
  } catch {
    return null;
  }
}

/** One line of a run's output, by what it is, so a page can show each its own way. */
export type AgentOutputLine =
  | { kind: 'pickup' }
  | { kind: 'session' }
  /** `server` is the MCP server of a tool like `mcp__ordo__add_comment`. */
  | { kind: 'tool'; tool: string; server: string | null; detail: string }
  | { kind: 'result'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'text'; text: string };

/** Reads a line back as `describeAgentEvent` wrote it; anything else is plain text. */
export function parseOutputLine(line: string): AgentOutputLine {
  if (line === AGENT_OUTPUT_PICKUP) return { kind: 'pickup' };
  if (line === 'Session started') return { kind: 'session' };
  if (line.startsWith('✗ ')) return { kind: 'error', text: line.slice(2) };
  if (line.startsWith('  ')) return { kind: 'result', text: line.slice(2) };
  const call = /^→ ([^\s:]+)(?:: (.*))?$/.exec(line);
  if (!call) return { kind: 'text', text: line };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call[1]!);
  let detail = call[2] ?? '';
  // Lines from before tool calls had a gist: their input as JSON, unless it was cut short.
  if (detail.startsWith('{')) {
    try {
      detail = toolGist(JSON.parse(detail));
    } catch {}
  }
  return {
    kind: 'tool',
    tool: mcp ? mcp[2]! : call[1]!,
    server: mcp ? mcp[1]! : null,
    detail,
  };
}

const BLOCK_LINE = /^\s*(?:[-*+] |\d+[.)] |\||>)/;

/**
 * What the agent said, as Markdown again. `describeAgentEvent` drops blank lines, so lines become
 * paragraphs of their own, except where they belong together: list items, tables and code.
 */
export function outputMarkdown(lines: string[]): string {
  let out = '';
  let fenced = false;
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    if (prev !== undefined)
      out += fenced || (BLOCK_LINE.test(prev) && BLOCK_LINE.test(line)) ? '\n' : '\n\n';
    out += line;
    if (line.trimStart().startsWith('```')) fenced = !fenced;
  });
  return out;
}

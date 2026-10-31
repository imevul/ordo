import { AGENT_OUTPUT_BYTES, AGENT_OUTPUT_LINE_CHARS, AGENT_OUTPUT_LINES } from './constants.ts';

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

/** The gist of a tool call's input: its command, path, pattern or URL, else its JSON. */
function toolGist(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
  }
  return oneLine(JSON.stringify(input));
}

/**
 * Readable lines for one line of Claude Code's `--output-format stream-json`: what the assistant
 * said and which tools it called (`→ Bash: pnpm test`). Tool results and bookkeeping events give
 * none. Null when the line isn't such an event, so it's shown as printed.
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
    case 'user':
    case 'result':
    case 'stream_event':
      return [];
    default:
      return null;
  }
}

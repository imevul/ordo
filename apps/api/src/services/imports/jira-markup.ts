/**
 * Jira's wiki markup → Markdown, for imported descriptions and comments. Covers what people mostly
 * write: headings, emphasis, monospace, links, mentions, lists, quotes, code blocks and tables.
 * Anything else stays as written, which still reads fine.
 */
export function jiraToMarkdown(text: string): string {
  const out: string[] = [];
  let inCode = false;
  let inQuote = false;
  let tableHeader = false;

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (inCode) {
      const end = line.search(/\{(code|noformat)\}/);
      if (end === -1) {
        out.push(line);
        continue;
      }
      if (line.slice(0, end).trim()) out.push(line.slice(0, end));
      out.push('```');
      inCode = false;
      continue;
    }

    const open = /^\s*\{(?:code|noformat)(?::([^}|]*))?[^}]*\}(.*)$/.exec(line);
    if (open) {
      const lang = open[1] && !open[1].includes('=') ? open[1].trim() : '';
      out.push(`\`\`\`${lang}`);
      inCode = true;
      const rest = open[2] ?? '';
      const end = rest.search(/\{(code|noformat)\}/);
      if (end === -1) {
        if (rest.trim()) out.push(rest);
      } else {
        if (rest.slice(0, end).trim()) out.push(rest.slice(0, end));
        out.push('```');
        inCode = false;
      }
      continue;
    }

    if (/^\s*\{quote\}\s*$/.test(line)) {
      inQuote = !inQuote;
      continue;
    }

    let md = convertLine(line);
    // Tables need a separator under their header row.
    if (/^\s*\|\|/.test(line)) {
      tableHeader = true;
    } else if (tableHeader) {
      const cells = (out.at(-1)!.match(/\|/g)?.length ?? 1) - 1;
      out.push(`|${' --- |'.repeat(cells)}`);
      tableHeader = false;
    }
    if (inQuote) md = `> ${md}`;
    out.push(md);
  }
  if (tableHeader) {
    const cells = (out.at(-1)!.match(/\|/g)?.length ?? 1) - 1;
    out.push(`|${' --- |'.repeat(cells)}`);
  }
  if (inCode) out.push('```');
  return out.join('\n');
}

function convertLine(line: string): string {
  if (/^\s*-{4,}\s*$/.test(line)) return '---';
  const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${inline(heading[2]!)}`;
  const quote = /^\s*bq\.\s+(.*)$/.exec(line);
  if (quote) return `> ${inline(quote[1]!)}`;
  const list = /^\s*([*#]+|-)\s+(.*)$/.exec(line);
  if (list) {
    const marker = list[1]!;
    const indent = '   '.repeat(marker.length - 1);
    return `${indent}${marker.endsWith('#') ? '1.' : '-'} ${inline(list[2]!)}`;
  }
  const header = /^\s*\|\|(.*?)\|\|\s*$/.exec(line);
  if (header)
    return `| ${inline(header[1]!)
      .split('||')
      .map((c) => c.trim())
      .join(' | ')} |`;
  const row = /^\s*\|(.*?)\|\s*$/.exec(line);
  if (row)
    return `| ${inline(row[1]!)
      .split('|')
      .map((c) => c.trim())
      .join(' | ')} |`;
  return inline(line);
}

/** Inline markup, leaving monospace spans alone. */
function inline(text: string): string {
  return text
    .replace(/\{\{(.+?)\}\}/g, '\u0000$1\u0000')
    .split('\u0000')
    .map((part, i) => (i % 2 ? `\`${part}\`` : emphasis(part)))
    .join('');
}

const EDGE_BEFORE = String.raw`(^|[\s(\[])`;
const EDGE_AFTER = String.raw`(?=$|[\s).,:;!?\]])`;

function emphasis(text: string): string {
  return (
    text
      .replace(/\{color(?::[^}]*)?\}/g, '')
      // [text|url], [url], mentions ([~name], [~accountid:…]).
      .replace(/\[~accountid:[^\]]+\]/g, '@someone')
      .replace(/\[~([^\]]+)\]/g, '@$1')
      .replace(
        /\[([^\]|]+)\|([^\]]+)\]/g,
        (_, label: string, url: string) => `[${label.trim()}](${url.trim()})`,
      )
      .replace(/\[(https?:\/\/[^\]\s]+)\]/g, '<$1>')
      .replace(/!(https?:\/\/[^!\s|]+)(?:\|[^!]*)?!/g, '![]($1)')
      .replace(/!([^!\s|]+\.\w{2,4})(?:\|[^!]*)?!/g, '($1)')
      .replace(new RegExp(`${EDGE_BEFORE}\\*(\\S(?:[^*]*?\\S)?)\\*${EDGE_AFTER}`, 'g'), '$1**$2**')
      .replace(new RegExp(`${EDGE_BEFORE}-(\\S(?:[^-]*?\\S)?)-${EDGE_AFTER}`, 'g'), '$1~~$2~~')
      .replace(new RegExp(`${EDGE_BEFORE}\\+(\\S(?:[^+]*?\\S)?)\\+${EDGE_AFTER}`, 'g'), '$1$2')
  );
}

/**
 * Markdown → Jira's wiki markup, for what Ordo writes to Jira (synced descriptions and comments).
 * The reverse of `jiraToMarkdown` for the same subset; anything else is sent as written.
 */
export function markdownToJira(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceLine = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);
    if (fence !== null) {
      if (fenceLine && fenceLine[1]!.startsWith(fence)) {
        out.push('{code}');
        fence = null;
      } else out.push(line);
      continue;
    }
    if (fenceLine) {
      fence = fenceLine[1]!;
      out.push(fenceLine[2] ? `{code:${fenceLine[2]}}` : '{code}');
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('----');
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`h${heading[1]!.length}. ${toWikiInline(heading[2]!)}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`bq. ${toWikiInline(quote[1]!)}`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.floor(item[1]!.replace(/\t/g, '    ').length / 2) + 1;
      const marker = /\d/.test(item[2]!) ? '#' : '*';
      // Task lists have no wiki equivalent; keep their boxes as text.
      out.push(`${marker.repeat(Math.min(depth, 6))} ${toWikiInline(item[3]!)}`);
      continue;
    }
    const cells = /^\s*\|(.*)\|\s*$/.exec(line);
    if (cells) {
      if (/^[\s|:-]+$/.test(line)) continue;
      const next = lines[i + 1] ?? '';
      const header = /^\s*\|?[\s|:-]+\|?\s*$/.test(next) && next.includes('-');
      const sep = header ? '||' : '|';
      const parts = cells[1]!.split('|').map((c) => toWikiInline(c.trim()));
      out.push(`${sep}${parts.join(sep)}${sep}`);
      continue;
    }
    out.push(toWikiInline(line));
  }
  if (fence !== null) out.push('{code}');
  return out.join('\n');
}

/** Inline Markdown → wiki markup, leaving code spans alone. */
function toWikiInline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 ? `{{${part.slice(1, -1)}}}` : wikiEmphasis(part)))
    .join('');
}

function wikiEmphasis(text: string): string {
  const BOLD = '\u0001';
  return (
    text
      .replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, '!$1!')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '[$1|$2]')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]')
      .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, `${BOLD}$2${BOLD}`)
      .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?!\w)/g, '$1_$2_')
      .replace(/~~(\S(?:.*?\S)?)~~/g, '-$1-')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the placeholder from above
      .replace(/\u0001/g, '*')
  );
}

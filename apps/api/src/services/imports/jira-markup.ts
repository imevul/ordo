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

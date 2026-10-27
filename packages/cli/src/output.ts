/** Terminal output: aligned columns, and color only for terminals that want it. */

export interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  error: (s: string) => string;
}

const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export function style(color: boolean): Style {
  if (!color) {
    const id = (s: string) => s;
    return { bold: id, dim: id, accent: id, error: id };
  }
  return { bold: wrap(1, 22), dim: wrap(2, 22), accent: wrap(35, 39), error: wrap(31, 39) };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the escape codes style() adds
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function truncate(s: string, width: number) {
  const chars = [...s];
  return chars.length <= width ? s : `${chars.slice(0, Math.max(width - 1, 0)).join('')}…`;
}

/**
 * Rows as columns padded to their widest cell. The last column takes what's left of `width`
 * and is cut to fit, so long titles don't wrap.
 */
export function table(rows: string[][], width = 100): string {
  if (!rows.length) return '';
  const cols = rows[0]!.length;
  const widths = Array.from({ length: cols - 1 }, (_, i) =>
    Math.max(...rows.map((r) => [...visible(r[i] ?? '')].length)),
  );
  const used = widths.reduce((a, b) => a + b + 2, 0);
  return rows
    .map((r) =>
      [
        ...widths.map((w, i) => {
          const cell = r[i] ?? '';
          return cell + ' '.repeat(w - [...visible(cell)].length);
        }),
        truncate(r[cols - 1] ?? '', Math.max(width - used, 20)),
      ].join('  '),
    )
    .join('\n');
}

export function relative(iso: string, now = Date.now()) {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
  ];
  if (s >= 30 * 86400) return iso.slice(0, 10);
  let [size, name] = units[0]!;
  for (const u of units) if (s >= u[0]) [size, name] = u;
  const n = Math.floor(s / size);
  return `${n} ${name}${n === 1 ? '' : 's'} ago`;
}

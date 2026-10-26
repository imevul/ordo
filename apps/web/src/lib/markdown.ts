// Markdown helpers that don't need the editor bundle.

/**
 * Content the rich editor would silently drop or flatten: raw HTML and footnotes. Such text opens in
 * the Markdown editor instead.
 */
export function richTextUnsafe(md: string) {
  const prose = md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
  return /<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>|<!--/.test(prose) || /\[\^[^\]\s]+\]/.test(prose);
}

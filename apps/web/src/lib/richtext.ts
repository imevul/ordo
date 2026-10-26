import type { AnyExtension, JSONContent } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

/**
 * The rich text editor's schema: only what GFM Markdown can store, because Markdown stays the
 * storage format (API, MCP, webhooks, chat and imports all speak it).
 */
export function richTextExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        // Relative links are issue links and attachments.
        isAllowedUri: (url, ctx) => url.startsWith('/') || ctx.defaultValidate(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    // Inline so an image inside a paragraph of text survives the round trip.
    Image.configure({ inline: true }),
  ];
}

const PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/**
 * Escapes text so it reads back as the same text, but only where Markdown would otherwise see
 * syntax: TipTap's default escapes every `_`, `*` and `&`, which litters API output (snake_case,
 * "2 * 3", "R&D") with backslashes and entities.
 */
export function escapeMarkdownText(text: string) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = i === 0 ? '' : text[i - 1]!;
    const next = text[i + 1] ?? '';
    switch (c) {
      case '\\':
        out += PUNCT.test(next) ? '\\\\' : c;
        break;
      case '`':
      case '~':
      case '[':
      case ']':
      case '|':
        out += `\\${c}`;
        break;
      case '*':
        out += i > 0 && SPACE.test(prev) && (next === '' || SPACE.test(next)) ? c : '\\*';
        break;
      case '_':
        out += ALNUM.test(prev) && ALNUM.test(next) ? c : '\\_';
        break;
      case '&':
        out += /^&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(text.slice(i)) ? '&amp;' : c;
        break;
      case '<':
        out += /[a-zA-Z/!?]/.test(next) ? '&lt;' : c;
        break;
      case '>':
      case '#':
      case '+':
      case '-':
        // Only line starts can open blockquotes, headings and lists; a text node may start a line.
        out +=
          i === 0 && (c === '>' || SPACE.test(next) || (c === '#' && next === '#')) ? `\\${c}` : c;
        break;
      default:
        out += c;
    }
  }
  return out.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3');
}

const INLINE = new Set(['text', 'image', 'hardBreak']);

/**
 * Wraps inline nodes that the Markdown parser leaves directly in a block container (an image on
 * its own line comes back as a bare image) in paragraphs, which the schema requires.
 */
function wrapInline(node: JSONContent): JSONContent {
  if (!node.content || ['paragraph', 'heading', 'codeBlock'].includes(node.type ?? '')) return node;
  const content: JSONContent[] = [];
  let run: JSONContent[] | null = null;
  for (const child of node.content) {
    if (!INLINE.has(child.type ?? '')) {
      content.push(wrapInline(child));
      run = null;
    } else if (run) run.push(child);
    else {
      run = [child];
      content.push({ type: 'paragraph', content: run });
    }
  }
  return { ...node, content };
}

/** Drops empty paragraphs (Enter pressed twice) that TipTap would otherwise write as `&nbsp;`. */
function dropEmptyParagraphs(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const kept = node.content
    .filter((c) => !(c.type === 'paragraph' && !c.content?.length))
    .map(dropEmptyParagraphs);
  return { ...node, content: kept.length || node.type === 'doc' ? kept : node.content };
}

export interface MarkdownConverter {
  parse(md: string): JSONContent;
  serialize(doc: JSONContent): string;
}

export function markdownConverter(extensions: AnyExtension[] = richTextExtensions()) {
  const manager = new MarkdownManager({ extensions });
  // Replaces a private method; the escaping rules above are the only change.
  Object.assign(manager, {
    encodeTextForMarkdown: (text: string, node: JSONContent, parent?: JSONContent) =>
      parent?.type === 'codeBlock' || node.marks?.some((m) => m.type === 'code')
        ? text
        : escapeMarkdownText(text),
  });
  return {
    parse: (md: string) => wrapInline(manager.parse(md)),
    serialize: (doc: JSONContent) =>
      manager
        .serialize(dropEmptyParagraphs(doc))
        // Tables come out wrapped in extra blank lines; collapse them outside code blocks.
        .split(/(```[\s\S]*?```)/g)
        .map((part, i) => (i % 2 ? part : part.replace(/\n{3,}/g, '\n\n')))
        .join('')
        .trim(),
  } satisfies MarkdownConverter;
}

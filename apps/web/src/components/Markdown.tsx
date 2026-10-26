import { useNavigate } from '@tanstack/react-router';
import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspace } from '../lib/workspace.tsx';

/**
 * Links issue identifiers (ENG-12) and @mentions outside of code spans and fences.
 * Kept as a string pre-pass so we do not need a custom remark plugin.
 */
function linkify(md: string, slug: string, teamKeys: Set<string>, usernames: Set<string>) {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/(^|[\s(])([A-Z][A-Z0-9]{0,6})-(\d+)\b/g, (m, pre, key, num) =>
          teamKeys.has(key) ? `${pre}[${key}-${num}](/${slug}/issue/${key}-${num})` : m,
        )
        .replace(/(^|[\s(])@([a-z0-9._-]{2,32})/g, (m, pre, name) =>
          usernames.has(name) ? `${pre}[@${name}](mention:${name})` : m,
        );
    })
    .join('');
}

export const Markdown = memo(function Markdown({
  source,
  className = '',
}: {
  source: string;
  className?: string;
}) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const text = useMemo(
    () =>
      linkify(
        source,
        ws.slug,
        new Set(ws.teams.map((t) => t.key)),
        new Set(ws.members.map((m) => m.username)),
      ),
    [source, ws.slug, ws.teams, ws.members],
  );
  return (
    <div className={`prose-ordo ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          a: ({ href = '', children }) => {
            if (href.startsWith('mention:')) return <span className="mention">{children}</span>;
            if (href.startsWith('/')) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({ to: href });
                  }}
                >
                  {children}
                </a>
              );
            }
            const safe = /^(https?:|mailto:)/i.test(href) ? href : '#';
            return (
              <a href={safe} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img: ({ src, alt }) =>
            typeof src === 'string' && /^https?:/i.test(src) ? (
              <img src={src} alt={alt ?? ''} className="max-w-full" />
            ) : null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

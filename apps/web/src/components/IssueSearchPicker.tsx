import type { Issue } from '@ordo/shared';
import { type ReactNode, useState } from 'react';
import { useSearch } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { StatusIcon } from './icons.tsx';
import { Popover } from './ui/Popover.tsx';

/** Popover that searches issues by title or identifier and returns the picked one. */
export function IssueSearchPicker({
  trigger,
  onPick,
  exclude = [],
}: {
  trigger: ReactNode;
  onPick: (issue: Issue) => void;
  exclude?: string[];
}) {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const { data } = useSearch(ws.slug, q);
  const results = (data?.issues ?? []).filter((i) => !exclude.includes(i.id)).slice(0, 10);
  return (
    <Popover trigger={trigger} width={380} onOpenChange={(o) => !o && setQ('')}>
      {(close) => (
        <div className="flex min-h-0 flex-col">
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                onPick(results[active]);
                close();
              }
            }}
            placeholder={t('issues.search.placeholder')}
            className="h-9 border-b border-border-soft bg-transparent px-3 text-[13px] outline-none placeholder:text-index"
          />
          <div className="min-h-0 overflow-y-auto py-1">
            {results.map((i, idx) => {
              const s = ws.stateById.get(i.stateId);
              return (
                <button
                  type="button"
                  key={i.id}
                  className="menu-item"
                  data-active={idx === active}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => {
                    onPick(i);
                    close();
                  }}
                >
                  {s && <StatusIcon type={s.type} color={s.color} />}
                  <span className="w-16 flex-none font-mono text-[11px] text-index">
                    {i.identifier}
                  </span>
                  <span className="truncate">{i.title}</span>
                </button>
              );
            })}
            {q && results.length === 0 && (
              <div className="px-3 py-3 font-mono text-[11px] text-index">
                {t('issues.search.noMatches')}
              </div>
            )}
            {!q && (
              <div className="px-3 py-3 font-mono text-[11px] text-index">
                {t('issues.search.typeToSearch')}
              </div>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

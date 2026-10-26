import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

export interface Option {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: ReactNode;
  keywords?: string;
}

interface Props {
  options: Option[];
  selected?: string[];
  multi?: boolean;
  placeholder?: string;
  onSelect: (value: string) => void;
  onClose?: () => void;
  /** Extra row offered when the query matches nothing, e.g. "Create label 'foo'". */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
}

/** Searchable, keyboard-driven option list used by every property picker. */
export function OptionList({
  options,
  selected = [],
  multi,
  placeholder = 'Filter…',
  onSelect,
  onClose,
  onCreate,
  createLabel,
}: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(q));
  }, [options, query]);
  const showCreate =
    !!onCreate &&
    query.trim() &&
    !filtered.some((o) => o.label.toLowerCase() === query.trim().toLowerCase());
  const count = filtered.length + (showCreate ? 1 : 0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: jump back to the first match when the query changes
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (i: number) => {
    if (i === filtered.length && showCreate) {
      onCreate!(query.trim());
      setQuery('');
      return;
    }
    const opt = filtered[i];
    if (!opt) return;
    onSelect(opt.value);
    if (!multi) onClose?.();
  };

  return (
    <div className="flex min-h-0 flex-col">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="h-9 flex-none border-b border-border-soft bg-transparent px-3 text-[13px] outline-none placeholder:text-index"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, count - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(active);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose?.();
          }
        }}
      />
      <div
        ref={listRef}
        className="min-h-0 overflow-y-auto py-1"
        role="listbox"
        aria-multiselectable={multi}
      >
        {filtered.map((o, i) => {
          const isSel = selected.includes(o.value);
          return (
            <button
              type="button"
              key={o.value}
              data-index={i}
              data-active={i === active}
              role="option"
              aria-selected={isSel}
              className="menu-item"
              onMouseMove={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {multi && (
                <span
                  className={`flex h-3.5 w-3.5 flex-none items-center justify-center border ${isSel ? 'border-primary bg-primary text-bg' : 'border-border'}`}
                >
                  {isSel && <Check size={10} strokeWidth={3} />}
                </span>
              )}
              {o.icon}
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="flex-none text-[11px] text-index">{o.hint}</span>}
              {!multi && isSel && <Check size={14} className="flex-none text-primary" />}
            </button>
          );
        })}
        {showCreate && (
          <button
            type="button"
            data-index={filtered.length}
            data-active={active === filtered.length}
            className="menu-item"
            onMouseMove={() => setActive(filtered.length)}
            onClick={() => choose(filtered.length)}
          >
            <span className="text-primary">+</span>
            <span className="truncate">
              {createLabel ? createLabel(query.trim()) : `Create "${query.trim()}"`}
            </span>
          </button>
        )}
        {count === 0 && (
          <div className="px-3 py-3 font-mono text-[11px] text-index">// no matches</div>
        )}
      </div>
    </div>
  );
}

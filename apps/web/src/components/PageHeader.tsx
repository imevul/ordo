import type { ReactNode } from 'react';

/** Top bar of every page: a mono HUD kicker ("ENG // ISSUES") above the title, actions on the right. */
export function PageHeader({
  kicker,
  title,
  actions,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex-none border-b border-border-soft">
      <div className="flex min-h-12 items-center gap-3 px-4 py-1.5">
        <div className="min-w-0 flex-1">
          {kicker && (
            <div className="kicker truncate text-[10.5px] leading-tight tracking-[0.14em] uppercase">
              {kicker}
            </div>
          )}
          <h1 className="truncate text-[15px] leading-tight font-semibold tracking-[-0.01em]">
            {title}
          </h1>
        </div>
        {actions && <div className="flex flex-none items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export const Sep = () => <span className="text-muted"> // </span>;

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="brackets max-w-md p-8 text-center">
        <div className="kicker">
          <span className="text-muted">// </span>
          {title}
          <span className="cursor-blink" aria-hidden />
        </div>
        {body && <p className="mt-3 text-[13.5px] text-muted">{body}</p>}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label = 'loading' }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10 font-mono text-[12px] text-index">
      &gt; {label}
      <span className="cursor-blink" aria-hidden />
    </div>
  );
}

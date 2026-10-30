import type { ReactNode } from 'react';
import { ApiError } from '../../api/client.ts';
import { OrdoMark } from '../../components/icons.tsx';
import { t } from '../../i18n/index.ts';

export function AuthLayout({
  kicker,
  title,
  children,
  footer,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="hud-ground flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <OrdoMark className="mb-8" />
        <div className="brackets">
          <div className="panel panel-raised p-7">
            <div className="kicker">
              <span className="text-muted">// </span>
              {kicker}
            </div>
            <h1 className="mt-2 text-[28px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
        {footer && <div className="mt-6 text-center text-[13px] text-muted">{footer}</div>}
        <p className="mt-10 text-center font-mono text-[10.5px] tracking-[0.12em] text-index uppercase">
          {t('auth.tagline')}
        </p>
      </div>
    </div>
  );
}

export function TextField({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
        {label}
      </span>
      <input className="input" {...props} />
    </label>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      className="mb-4 border border-error/40 bg-error/[0.06] px-3 py-2 text-[13px] text-error"
      role="alert"
    >
      {error}
    </p>
  );
}

export const message = (err: unknown) =>
  err instanceof ApiError || err instanceof Error ? err.message : t('common.error');

export function OrDivider({ className }: { className: string }) {
  return (
    <div
      className={`${className} flex items-center gap-3 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase`}
    >
      <span className="h-px flex-1 bg-border-soft" />
      {t('auth.or')}
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

export function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="mt-4 w-full text-center font-mono text-[11px] tracking-[0.1em] text-index uppercase hover:text-text"
      onClick={onClick}
    >
      ← {children}
    </button>
  );
}

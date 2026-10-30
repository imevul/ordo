import type { ReactNode } from 'react';
import { t } from '../../i18n/index.ts';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** Whichever of `forms` is known, else the raw value (the API may add new ones). */
export const known = <K extends string>(
  value: string,
  forms: readonly K[],
  label: (k: K) => string,
) => ((forms as readonly string[]).includes(value) ? label(value as K) : value);

export function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="section-label mb-2">{title}</div>
      {description && <p className="mb-4 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="bg-bg px-4 py-3">
      <div className="font-mono text-[10px] tracking-[0.16em] text-index uppercase">{label}</div>
      <div className={`mt-1 font-mono text-[18px] font-semibold ${tone ?? 'text-text'}`}>
        {value}
      </div>
    </div>
  );
}

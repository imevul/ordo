import type { ReactNode } from 'react';

/** Building blocks shared by the settings sections (kept apart from index.tsx, which imports them all). */

export function SettingsCard({
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

export function FormRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[12px] text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-index">{hint}</span>}
    </label>
  );
}

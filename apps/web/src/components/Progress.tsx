import type { Progress } from '@ordo/shared';

export function ProgressBar({
  progress,
  className = '',
}: {
  progress: Progress;
  className?: string;
}) {
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="progress-track flex-1">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 flex-none text-right font-mono text-[11px] text-muted">{pct}%</span>
    </div>
  );
}

export function ProgressStats({ progress }: { progress: Progress }) {
  const remaining = progress.total - progress.completed - progress.canceled;
  const cells: [string, number, string][] = [
    ['scope', progress.total, 'text-text'],
    ['started', progress.started, 'text-warning'],
    ['completed', progress.completed, 'text-success'],
    ['remaining', remaining, 'text-muted'],
  ];
  return (
    <div className="grid grid-cols-4 gap-px bg-border-soft">
      {cells.map(([label, n, color]) => (
        <div key={label} className="bg-bg px-3 py-2.5">
          <div className="font-mono text-[10px] tracking-[0.16em] text-index uppercase">
            {label}
          </div>
          <div className={`mt-0.5 font-mono text-[18px] font-semibold ${color}`}>{n}</div>
        </div>
      ))}
    </div>
  );
}

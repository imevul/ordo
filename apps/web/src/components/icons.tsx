import type { ProjectStatus, StateType } from '@ordo/shared';

/**
 * Status glyphs are squares, not circles — Hotline Pink has no rounded shapes.
 * Fill grows with progress: dashed (backlog) → outline → half → solid with a check.
 */
export function StatusIcon({
  type,
  color,
  size = 14,
}: {
  type: StateType;
  color: string;
  size?: number;
}) {
  const s = size;
  const common = {
    width: s,
    height: s,
    viewBox: '0 0 14 14',
    'aria-hidden': true,
    className: 'flex-none',
  } as const;
  switch (type) {
    case 'triage':
      return (
        <svg {...common}>
          <path d="M7 1.2 12.8 7 7 12.8 1.2 7Z" fill="none" stroke={color} strokeWidth="1.4" />
          <rect x="5.6" y="5.6" width="2.8" height="2.8" fill={color} />
        </svg>
      );
    case 'backlog':
      return (
        <svg {...common}>
          <rect
            x="1.7"
            y="1.7"
            width="10.6"
            height="10.6"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
            strokeDasharray="2.2 1.8"
          />
        </svg>
      );
    case 'unstarted':
      return (
        <svg {...common}>
          <rect
            x="1.7"
            y="1.7"
            width="10.6"
            height="10.6"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
          />
        </svg>
      );
    case 'started':
      return (
        <svg {...common}>
          <rect
            x="1.7"
            y="1.7"
            width="10.6"
            height="10.6"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
          />
          <rect x="4" y="7" width="6" height="3" fill={color} />
          <rect x="4" y="4" width="3" height="3" fill={color} />
        </svg>
      );
    case 'completed':
      return (
        <svg {...common}>
          <rect x="1" y="1" width="12" height="12" fill={color} />
          <path d="M4 7.2 6.1 9.3 10.2 4.9" fill="none" stroke="#09090b" strokeWidth="1.6" />
        </svg>
      );
    case 'canceled':
      return (
        <svg {...common}>
          <rect x="1" y="1" width="12" height="12" fill={color} />
          <path d="M4.6 4.6 9.4 9.4M9.4 4.6 4.6 9.4" stroke="#09090b" strokeWidth="1.6" />
        </svg>
      );
  }
}

export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 14 14',
    'aria-hidden': true,
    className: 'flex-none',
  } as const;
  if (priority === 1) {
    return (
      <svg {...common}>
        <rect x="1" y="1" width="12" height="12" fill="#f59e0b" />
        <rect x="6.2" y="3" width="1.6" height="5.2" fill="#09090b" />
        <rect x="6.2" y="9.4" width="1.6" height="1.6" fill="#09090b" />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg {...common}>
        {[1.5, 5.75, 10].map((x) => (
          <rect key={x} x={x} y="6.4" width="2.5" height="1.2" fill="#8e7985" />
        ))}
      </svg>
    );
  }
  const filled = 5 - priority; // high = 3 bars, medium = 2, low = 1
  return (
    <svg {...common}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4.25}
          y={10 - (i + 1) * 3 + 2}
          width="2.75"
          height={(i + 1) * 3}
          style={{ fill: i < filled ? 'var(--color-text)' : 'var(--color-border)' }}
        />
      ))}
    </svg>
  );
}

const PROJECT_STATUS_COLOR: Record<ProjectStatus, string> = {
  backlog: '#8e7985',
  planned: '#b8aab2',
  started: '#f59e0b',
  paused: '#8e7985',
  completed: '#22c55e',
  canceled: '#8e7985',
};

export function ProjectStatusIcon({ status, size = 14 }: { status: ProjectStatus; size?: number }) {
  const type: StateType =
    status === 'backlog'
      ? 'backlog'
      : status === 'planned'
        ? 'unstarted'
        : status === 'completed'
          ? 'completed'
          : status === 'canceled'
            ? 'canceled'
            : 'started';
  return <StatusIcon type={type} color={PROJECT_STATUS_COLOR[status]} size={size} />;
}

/** A project's mark: a small chamfered tile in the project's color. */
export function ProjectIcon({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="flex-none">
      <path d="M1 1H10L13 4V13H4L1 10Z" fill="none" stroke={color} strokeWidth="1.4" />
      <rect x="5" y="5" width="4" height="4" fill={color} />
    </svg>
  );
}

export function TeamIcon({
  color,
  size = 16,
  label,
}: {
  color: string;
  size?: number;
  label: string;
}) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center font-mono text-[9px] font-bold"
      style={{
        width: size,
        height: size,
        background: color,
        color: '#09090b',
        clipPath:
          'polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px))',
      }}
      aria-hidden
    >
      {label.slice(0, 1)}
    </span>
  );
}

export function OrdoMark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="brand-bar h-5" aria-hidden />
      <span className="font-mono text-[13px] font-semibold tracking-[0.04em] text-text">ORDO</span>
    </span>
  );
}

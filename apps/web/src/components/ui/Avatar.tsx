import { initials } from '../../lib/format.ts';

export function Avatar({ name, color, size = 18 }: { name: string; color: string; size?: number }) {
  const cut = Math.max(3, Math.round(size / 5));
  return (
    <span
      title={name}
      className="inline-flex flex-none select-none items-center justify-center font-mono font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.42)),
        background: color,
        color: '#09090b',
        clipPath: `polygon(0 0, calc(100% - ${cut}px) 0, 100% ${cut}px, 100% 100%, ${cut}px 100%, 0 calc(100% - ${cut}px))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyAvatar({ size = 18 }: { size?: number }) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center border border-dashed border-index"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

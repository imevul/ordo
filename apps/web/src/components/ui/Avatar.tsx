import type { UserStatus } from '@ordo/shared';
import { initials } from '../../lib/format.ts';
import { statusDotColor, statusLine } from '../../lib/status.ts';

/**
 * A chamfered square: the uploaded picture when there is one, otherwise initials on the user's
 * colour. With a status, a small square in the uncut corner says how available they are.
 */
export function Avatar({
  status,
  ...props
}: {
  name: string;
  color: string;
  src?: string | null;
  size?: number;
  status?: UserStatus | null;
}) {
  if (!status) return <AvatarImage {...props} />;
  const size = props.size ?? 18;
  const dot = Math.max(5, Math.round(size / 3));
  return (
    <span
      className="relative inline-flex flex-none"
      title={`${props.name} — ${statusLine(status)}`}
    >
      <AvatarImage {...props} />
      <span
        className="absolute"
        style={{
          width: dot,
          height: dot,
          right: -1,
          bottom: -1,
          background: statusDotColor(status),
          boxShadow: '0 0 0 1.5px var(--color-surface)',
        }}
      />
    </span>
  );
}

function AvatarImage({
  name,
  color,
  src,
  size = 18,
}: {
  name: string;
  color: string;
  src?: string | null;
  size?: number;
}) {
  const cut = Math.max(3, Math.round(size / 5));
  const clipPath = `polygon(0 0, calc(100% - ${cut}px) 0, 100% ${cut}px, 100% 100%, ${cut}px 100%, 0 calc(100% - ${cut}px))`;
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        title={name}
        width={size}
        height={size}
        className="flex-none object-cover"
        style={{ width: size, height: size, clipPath, background: color }}
      />
    );
  }
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
        clipPath,
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

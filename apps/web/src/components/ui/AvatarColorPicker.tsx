import { AVATAR_COLORS } from '@ordo/shared';
import { t } from '../../i18n/index.ts';

/** A row of swatches for the colour behind someone's initials. */
export function AvatarColorPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (color: string) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {AVATAR_COLORS.map((c) => (
        <button
          type="button"
          key={c}
          onClick={() => onChange(c)}
          className={`h-5 w-5 ${value === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
          style={{ background: c }}
          aria-label={t('settings.profile.colour', { color: c })}
          aria-pressed={value === c}
        />
      ))}
    </div>
  );
}

import {
  ACCENT_PRESETS,
  accentVariables,
  contrast,
  DEFAULT_ACCENT,
  HEX_COLOR,
  THEME_BACKGROUND,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys } from '../../../api/queries.ts';
import { t } from '../../../i18n/index.ts';
import { useTheme } from '../../../lib/theme.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg } from './shared.ts';

/** A preset's name in the reader's language; Hotline Pink is a name and stays as it is. */
function presetName(name: string) {
  const names: Record<string, string> = {
    Ember: t('workspaceSettings.accent.presets.ember'),
    Amber: t('workspaceSettings.accent.presets.amber'),
    Acid: t('workspaceSettings.accent.presets.acid'),
    Mint: t('workspaceSettings.accent.presets.mint'),
    Electric: t('workspaceSettings.accent.presets.electric'),
    Violet: t('workspaceSettings.accent.presets.violet'),
  };
  return names[name] ?? name;
}

/**
 * The workspace's accent colour: presets, or any colour that reads on the dark background. The
 * light theme deepens it on its own (accentVariables), so only the dark background is checked.
 */
export function AccentCard() {
  const ws = useWorkspace();
  const { mode } = useTheme();
  const qc = useQueryClient();
  const saved = ws.workspace.settings.accentColor ?? DEFAULT_ACCENT;
  const [draft, setDraft] = useState(saved);
  const valid = HEX_COLOR.test(draft);
  const faint = valid && contrast(draft, THEME_BACKGROUND) < 3;
  const save = async (color: string) => {
    try {
      await api.patch(wsPath(ws.slug, '/'), {
        settings: {
          accentColor: color.toLowerCase() === DEFAULT_ACCENT ? null : color.toLowerCase(),
        },
      });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
      toast.success(t('workspaceSettings.accent.saved'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title={t('workspaceSettings.accent.title')}
      description={t('workspaceSettings.accent.description')}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.color}
            type="button"
            onClick={() => setDraft(p.color)}
            className={`flex items-center gap-2 border px-2.5 py-1.5 text-[12.5px] ${draft.toLowerCase() === p.color ? 'border-text text-text' : 'border-border-soft text-muted hover:text-text'}`}
            aria-pressed={draft.toLowerCase() === p.color}
          >
            <span className="h-3 w-3" style={{ background: p.color }} />
            {presetName(p.name)}
          </button>
        ))}
      </div>
      <div className="mb-4 flex items-center gap-2">
        <input
          type="color"
          className="h-8 w-10 cursor-pointer border border-border bg-bg p-0.5"
          value={valid ? draft : DEFAULT_ACCENT}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t('workspaceSettings.accent.custom')}
        />
        <input
          className="input w-32 font-mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value.trim())}
          aria-label={t('workspaceSettings.accent.hex')}
        />
      </div>
      {/* The palette is a set of CSS variables, so this box previews it without touching the page. */}
      <div
        className="mb-4 border border-border-soft bg-bg p-4"
        style={valid ? (accentVariables(draft, mode) as React.CSSProperties) : undefined}
      >
        <div className="kicker mb-2">
          <span className="text-muted">// </span>
          {t('workspaceSettings.accent.preview')}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="btn btn-primary btn-sm">
            {t('workspaceSettings.accent.previewPrimary')}
          </span>
          <span className="btn btn-ghost btn-sm">{t('workspaceSettings.accent.previewGhost')}</span>
          <span className="chip [--chip:var(--color-primary)]">
            {t('workspaceSettings.accent.previewChip')}
          </span>
          <span className="text-[13px] text-highlight">
            {t('workspaceSettings.accent.previewLink')}
          </span>
          <span className="h-[7px] w-[7px] bg-primary shadow-[0_0_10px_var(--color-primary)]" />
          <span className="text-[12px] text-muted">
            {t('workspaceSettings.accent.previewMuted')}
          </span>
        </div>
      </div>
      {faint && (
        <p className="mb-3 text-[12px] text-warning">{t('workspaceSettings.accent.tooFaint')}</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || draft.toLowerCase() === saved.toLowerCase()}
          onClick={() => save(draft)}
        >
          {t('common.save')}
        </button>
        {saved !== DEFAULT_ACCENT && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDraft(DEFAULT_ACCENT);
              save(DEFAULT_ACCENT);
            }}
          >
            {t('workspaceSettings.accent.reset')}
          </button>
        )}
      </div>
    </SettingsCard>
  );
}

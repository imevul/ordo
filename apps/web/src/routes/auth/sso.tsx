import type { SsoDiscovery, SsoOption } from '@ordo/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { t } from '../../i18n/index.ts';
import { ssoStartUrl } from '../../lib/sso.ts';

import { BackLink } from './ui.tsx';

export function SsoButtons({ options, redirect }: { options: SsoOption[]; redirect?: string }) {
  // Several workspaces may share a domain; say which one each button is for.
  const many = new Set(options.map((o) => o.workspace)).size > 1;
  return options.map((o) => (
    <a
      key={o.providerId}
      href={ssoStartUrl(o.providerId, { redirect })}
      className="btn btn-primary mb-2 w-full"
    >
      {t('auth.login.continueWith', { name: o.name })}
      {many && <span className="text-[11px] opacity-70">· {o.workspace}</span>}
      <span className="arrow">→</span>
    </a>
  ));
}

/** "Sign in with SSO": the workspace's URL name → its providers. */
export function WorkspaceSso({
  initial,
  redirect,
  onBack,
}: {
  initial: string;
  redirect?: string;
  onBack: () => void;
}) {
  const [slug, setSlug] = useState(initial);
  const [found, setFound] = useState<SsoDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const lookUp = async (value: string) => {
    // Accept a pasted URL ("https://ordo.example.com/acme/") as well as the bare name.
    const clean = value.trim().toLowerCase().replace(/\/+$/, '').replace(/^.*\//, '');
    if (!clean) return;
    setBusy(true);
    try {
      setFound(
        await api.get<SsoDiscovery>(`/auth/providers?workspace=${encodeURIComponent(clean)}`),
      );
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: look up a workspace from the link once
  useEffect(() => {
    if (initial) lookUp(initial);
  }, []);
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookUp(slug);
        }}
      >
        <label className="mb-4 block">
          <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
            {t('auth.workspaceSso.workspaceUrl')}
          </span>
          <div className="input flex items-center gap-0 p-0">
            <span className="pl-3 font-mono text-[12.5px] text-index">{location.host}/</span>
            <input
              className="min-w-0 flex-1 bg-transparent py-2 pr-3 font-mono text-[12.5px] outline-none"
              required
              autoFocus={!initial}
              placeholder="acme"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setFound(null);
              }}
              aria-label={t('auth.workspaceSso.workspaceUrl')}
            />
          </div>
        </label>
        {!found?.options.length && (
          <button className="btn btn-primary w-full" disabled={busy}>
            {t('common.continue')} <span className="arrow">→</span>
          </button>
        )}
      </form>
      {found && found.options.length === 0 && (
        <p className="mt-4 text-[13px] text-muted">{t('auth.workspaceSso.noSso')}</p>
      )}
      {found && found.options.length > 0 && (
        <SsoButtons options={found.options} redirect={redirect} />
      )}
      <BackLink onClick={onBack}>{t('auth.workspaceSso.backToEmail')}</BackLink>
    </>
  );
}

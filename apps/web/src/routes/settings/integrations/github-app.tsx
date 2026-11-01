import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t, tx } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { errMsg } from './shared.ts';

export function GithubAppPanel({ onCancel }: { onCancel: () => void }) {
  const ws = useWorkspace();
  const { data } = useQuery({
    queryKey: ['ws', ws.slug, 'github-app'],
    queryFn: () =>
      api.get<{
        app: { name: string; htmlUrl: string } | null;
        canCreate: boolean;
        publicUrl: string;
      }>(wsPath(ws.slug, '/integrations/github/app')),
  });
  const [org, setOrg] = useState('');
  if (!data) return <Spinner />;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { action, manifest } = await api.post<{ action: string; manifest: string }>(
        wsPath(ws.slug, '/integrations/github/manifest'),
        { org: org.trim() || undefined },
      );
      // GitHub takes the manifest as a form POST.
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = manifest;
      form.append(input);
      document.body.append(form);
      form.submit();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  /** Signs in to GitHub to connect an installation; `fresh` installs the app somewhere new. */
  const install = async (fresh?: boolean) => {
    try {
      const { url } = await api.post<{ url: string }>(
        wsPath(ws.slug, '/integrations/github/install'),
        { fresh },
      );
      window.location.assign(url);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div>
      <p className="mb-4 text-[12.5px] text-muted">
        {tx('integrations.githubApp.intro', {
          url: <span className="font-mono">{data.publicUrl}</span>,
        })}
      </p>
      {data.app ? (
        <div className="flex flex-col items-start gap-3">
          <button type="button" className="btn btn-primary" onClick={() => install()}>
            {t('integrations.githubApp.install')} <span className="arrow">→</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm h-auto max-w-full whitespace-normal text-left"
            onClick={() => install(true)}
          >
            {t('integrations.githubApp.installElsewhere', { app: data.app.name })}
          </button>
          <p className="text-[12px] text-index">{t('integrations.githubApp.makePublic')}</p>
        </div>
      ) : data.canCreate ? (
        <form onSubmit={create}>
          <FormRow
            label={t('integrations.githubApp.org')}
            hint={t('integrations.githubApp.orgHint')}
          >
            <input
              className="input"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="acme"
            />
          </FormRow>
          <button className="btn btn-primary">
            {t('integrations.githubApp.create')} <span className="arrow">→</span>
          </button>
        </form>
      ) : (
        <p className="text-[13px] text-muted">{t('integrations.githubApp.needsInstanceAdmin')}</p>
      )}
      <div className="mt-6 flex justify-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

interface Choice {
  id: string;
  account: string;
  type: string;
  avatarUrl: string | null;
  connected: boolean;
}

/**
 * Where the GitHub sign-in lands when it found several installations: the admin picks one. The
 * list comes from the server, which only connects one GitHub said this user can see.
 */
export function GithubInstallationChooser({
  state,
  onClose,
  onDone,
}: {
  state: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  const { data: app } = useQuery({
    queryKey: ['ws', ws.slug, 'github-app'],
    queryFn: () =>
      api.get<{ app: { name: string } | null }>(wsPath(ws.slug, '/integrations/github/app')),
  });
  const { data, error } = useQuery({
    queryKey: ['ws', ws.slug, 'github-choices', state],
    queryFn: () =>
      api.get<{ installations: Choice[] }>(
        wsPath(ws.slug, `/integrations/github/choices?state=${encodeURIComponent(state)}`),
      ),
    retry: false,
  });

  const connect = async (id: string) => {
    setBusy(true);
    try {
      await api.post(wsPath(ws.slug, '/integrations/github/connect'), {
        state,
        installationId: id,
      });
      onDone();
    } catch (err) {
      toast.error(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} width={480} label={t('integrations.githubApp.chooseTitle')}>
      <div className="p-6">
        <div className="section-label mb-3">{t('integrations.githubApp.chooseTitle')}</div>
        {error ? (
          <p className="text-[13px] text-error">{errMsg(error)}</p>
        ) : !data ? (
          <Spinner />
        ) : (
          <>
            <p className="mb-4 text-[12.5px] text-muted">
              {t('integrations.githubApp.chooseIntro', { app: app?.app?.name ?? 'GitHub' })}
            </p>
            <div className="border border-border-soft">
              {data.installations.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="menu-item w-full disabled:opacity-50"
                  disabled={busy || i.connected}
                  onClick={() => connect(i.id)}
                >
                  {i.avatarUrl ? (
                    <img src={i.avatarUrl} alt="" className="size-5 flex-none" />
                  ) : (
                    <span className="size-5 flex-none bg-border-soft" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">{i.account}</span>
                  <span className="font-mono text-[11px] text-index">
                    {i.connected
                      ? t('integrations.githubApp.connected')
                      : i.type === 'Organization'
                        ? t('integrations.githubApp.organisation')
                        : t('integrations.githubApp.user')}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="mt-6 flex justify-end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

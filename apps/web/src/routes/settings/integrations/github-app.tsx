import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
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

  const install = async () => {
    try {
      const { url } = await api.post<{ url: string }>(
        wsPath(ws.slug, '/integrations/github/install'),
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
        <button type="button" className="btn btn-primary" onClick={install}>
          {t('integrations.githubApp.install', { app: data.app.name })}{' '}
          <span className="arrow">→</span>
        </button>
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

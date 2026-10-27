import type { AiSettings, WorkspaceAi } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { keys } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { getLocale, INTL_TAG, t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

/**
 * Settings → AI assistance. A workspace uses the instance's model (if an instance admin set one
 * up), its own, or none. Its own model is used instead of the instance's whenever it's chosen.
 */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

const HINTS: Record<AiSettings['provider'], { model: string; baseUrl: string }> = {
  anthropic: { model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' },
  openai: { model: 'llama3.3', baseUrl: 'http://localhost:11434/v1' },
};

type Choice = 'off' | 'instance' | 'workspace';

export function AiSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'ai-settings'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkspaceAi>(wsPath(ws.slug, '/ai/settings')),
    enabled: ws.isAdmin,
  });
  // Picking "our own model" before there is one only opens the form; saving it switches.
  const [picked, setPicked] = useState<Choice | null>(null);
  if (!ws.isAdmin) return <p className="text-muted">{t('workspaceSettings.ai.adminsOnly')}</p>;
  if (!data) return <Spinner />;

  const current: Choice = data.enabled ? data.source : 'off';
  const choice = picked ?? current;
  const refresh = () => {
    setPicked(null);
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
  };

  const choose = async (next: Choice) => {
    if (next === 'workspace' && !data.own) return setPicked('workspace');
    try {
      await api.patch(wsPath(ws.slug, '/'), {
        settings: next === 'off' ? { aiEnabled: false } : { aiEnabled: true, aiSource: next },
      });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const describe = (m: { provider: AiSettings['provider']; model: string }) =>
    m.provider === 'anthropic'
      ? t('workspaceSettings.ai.claude', { model: m.model })
      : t('workspaceSettings.ai.local', { model: m.model });

  const options: { value: Choice; label: string; hint: string }[] = [
    {
      value: 'instance',
      label: t('workspaceSettings.ai.useInstance'),
      hint: data.instance
        ? `${data.instance.provider === 'anthropic' ? t('workspaceSettings.ai.anthropic') : t('workspaceSettings.ai.openai')} · ${data.instance.model}`
        : t('workspaceSettings.ai.instanceNone'),
    },
    {
      value: 'workspace',
      label: t('workspaceSettings.ai.useOwn'),
      hint: data.own
        ? `${data.own.provider === 'anthropic' ? t('workspaceSettings.ai.anthropic') : t('workspaceSettings.ai.openai')} · ${data.own.model}`
        : t('workspaceSettings.ai.ownNone'),
    },
    { value: 'off', label: t('workspaceSettings.ai.off'), hint: t('workspaceSettings.ai.offHint') },
  ];
  const active = choice === 'workspace' ? data.own : choice === 'instance' ? data.instance : null;

  return (
    <>
      <SettingsCard
        title={t('workspaceSettings.ai.title')}
        description={active ? describe(active) : t('workspaceSettings.ai.intro')}
      >
        <div className="mb-1 text-[12px] text-muted">{t('workspaceSettings.ai.which')}</div>
        {options.map((o) => (
          <label key={o.value} className="mb-2 flex items-start gap-2 text-[13.5px]">
            <input
              type="radio"
              name="ai-source"
              className="mt-1 accent-primary"
              checked={choice === o.value}
              onChange={() => choose(o.value)}
            />
            <span>
              {o.label}
              <span className="block font-mono text-[11.5px] text-index">{o.hint}</span>
            </span>
          </label>
        ))}
        {choice === 'instance' && !data.instance && (
          <p className="mt-2 text-[12.5px] text-warning">
            {t('workspaceSettings.ai.instanceMissing')}
          </p>
        )}
      </SettingsCard>
      {choice === 'workspace' && <OwnModelCard data={data} onSaved={refresh} />}
    </>
  );
}

function OwnModelCard({ data, onSaved }: { data: WorkspaceAi; onSaved: () => void }) {
  const ws = useWorkspace();
  const own = data.own;
  const [provider, setProvider] = useState<AiSettings['provider']>(own?.provider ?? 'anthropic');
  const [model, setModel] = useState(own?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(own?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const hint = HINTS[provider];
  const sameProvider = own?.provider === provider;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(wsPath(ws.slug, '/ai/provider'), {
        provider,
        model: model.trim() || hint.model,
        baseUrl: provider === 'openai' ? baseUrl.trim() || hint.baseUrl : null,
        // Empty keeps the stored key, but only for the provider it was stored for.
        apiKey: apiKey.trim() || (sameProvider ? '' : null),
      });
      setApiKey('');
      toast.success(t('workspaceSettings.ai.saved'));
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post<{ reply: string; ms: number }>(wsPath(ws.slug, '/ai/provider/test'));
      const seconds = new Intl.NumberFormat(INTL_TAG[getLocale()], {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(r.ms / 1000);
      toast.success(t('workspaceSettings.ai.answered', { seconds, reply: r.reply }));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t('workspaceSettings.ai.removeTitle'),
      body: t('workspaceSettings.ai.removeBody'),
      confirmLabel: t('workspaceSettings.ai.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(wsPath(ws.slug, '/ai/provider'));
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const row = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13.5px]';
  return (
    <SettingsCard
      title={t('workspaceSettings.ai.ownTitle')}
      description={t('workspaceSettings.ai.ownDescription')}
    >
      <form onSubmit={submit} className="space-y-3">
        <label className={row}>
          {t('workspaceSettings.ai.provider')}
          <select
            className="input w-72 max-w-full"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as AiSettings['provider']);
              setModel('');
              setBaseUrl('');
            }}
          >
            <option value="anthropic">{t('workspaceSettings.ai.anthropic')}</option>
            <option value="openai">{t('workspaceSettings.ai.openai')}</option>
          </select>
        </label>
        {provider === 'anthropic' && (
          <p className="text-[12px] text-index">{t('workspaceSettings.ai.anthropicNote')}</p>
        )}
        <label className={row}>
          {t('workspaceSettings.ai.model')}
          <input
            className="input w-72 max-w-full font-mono"
            placeholder={hint.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        {provider === 'openai' && (
          <label className={row}>
            <span className="min-w-0 flex-1">
              {t('workspaceSettings.ai.baseUrl')}
              <span className="block text-[12px] text-index">
                {data.allowPrivateNetwork
                  ? t('workspaceSettings.ai.baseUrlHint')
                  : t('workspaceSettings.ai.baseUrlPublicOnly')}
              </span>
            </span>
            <input
              className="input w-72 max-w-full font-mono"
              placeholder={hint.baseUrl}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
        )}
        <label className={row}>
          <span className="min-w-0 flex-1">
            {t('workspaceSettings.ai.apiKey')}
            <span className="block text-[12px] text-index">
              {sameProvider && own?.apiKey
                ? t('workspaceSettings.ai.apiKeyCurrent', { key: own.apiKey })
                : provider === 'openai'
                  ? t('workspaceSettings.ai.apiKeyOptional')
                  : t('workspaceSettings.ai.apiKeyConsole')}
            </span>
          </span>
          <input
            className="input w-72 max-w-full font-mono"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2 pt-1">
          <button className="btn btn-primary" disabled={busy}>
            {own ? t('common.save') : t('workspaceSettings.ai.saveAndUse')}
          </button>
          {own && (
            <>
              <button type="button" className="btn btn-ghost" onClick={test} disabled={testing}>
                {testing ? t('workspaceSettings.ai.testing') : t('workspaceSettings.ai.test')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={remove}>
                {t('workspaceSettings.ai.remove')}
              </button>
            </>
          )}
        </div>
      </form>
    </SettingsCard>
  );
}

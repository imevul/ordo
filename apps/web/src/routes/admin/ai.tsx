import type { AiSettings } from '@ordo/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { getLocale, INTL_TAG, t } from '../../i18n/index.ts';

import { Card, errMsg } from './ui.tsx';

const MODEL_HINTS: Record<AiSettings['provider'], { model: string; baseUrl: string }> = {
  anthropic: { model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' },
  openai: { model: 'llama3.3', baseUrl: 'http://localhost:11434/v1' },
};

/**
 * The model behind AI assistance. Off by default: turning it on sends issue text to whatever is
 * chosen here whenever someone asks for a summary, a draft or suggestions.
 */
export function AiCard({
  value,
  locked,
  unreadable,
  save,
}: {
  value: AiSettings | null;
  locked: boolean;
  unreadable: boolean;
  save: (patch: object) => Promise<void>;
}) {
  const [provider, setProvider] = useState<AiSettings['provider'] | 'off'>(
    value?.provider ?? 'off',
  );
  const [model, setModel] = useState(value?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(value?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const hint = provider === 'off' ? null : MODEL_HINTS[provider];
  const sameProvider = value?.provider === provider;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (provider === 'off') return save({ ai: null });
    await save({
      ai: {
        provider,
        model: model.trim() || hint!.model,
        baseUrl: baseUrl.trim() || (provider === 'openai' ? hint!.baseUrl : null),
        // Empty keeps the stored key, but only for the provider it was stored for.
        apiKey: apiKey.trim() || (sameProvider ? '' : null),
      },
    });
    setApiKey('');
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post<{ reply: string; ms: number }>('/admin/settings/test-ai');
      const seconds = new Intl.NumberFormat(INTL_TAG[getLocale()], {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(r.ms / 1000);
      toast.success(t('admin.ai.answered', { seconds, reply: r.reply }));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card title={t('admin.ai.title')} description={t('admin.ai.description')}>
      {locked ? (
        <p className="font-mono text-[12.5px] text-muted">
          {t('admin.ai.fromEnv', {
            value: value
              ? `${value.provider} · ${value.model}${value.baseUrl ? ` · ${value.baseUrl}` : ''}`
              : t('admin.ai.off'),
          })}
          <span className="tag ml-2 font-mono">{t('admin.settings.setByEnv')}</span>
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="flex items-center justify-between gap-4 text-[13.5px]">
            {t('admin.ai.provider')}
            <select
              className="input w-72"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as typeof provider);
                setModel('');
                setBaseUrl('');
              }}
            >
              <option value="off">{t('admin.ai.providerOff')}</option>
              <option value="anthropic">{t('admin.ai.anthropic')}</option>
              <option value="openai">{t('admin.ai.openai')}</option>
            </select>
          </label>
          {hint && (
            <>
              {provider === 'anthropic' && (
                <p className="text-[12px] text-index">{t('admin.ai.anthropicNote')}</p>
              )}
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                {t('admin.ai.model')}
                <input
                  className="input w-72 font-mono"
                  placeholder={hint.model}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                <span>
                  {t('admin.ai.baseUrl')}
                  <span className="block text-[12px] text-index">
                    {provider === 'openai'
                      ? t('admin.ai.baseUrlOpenai')
                      : t('admin.ai.baseUrlAnthropic')}
                  </span>
                </span>
                <input
                  className="input w-72 font-mono"
                  placeholder={hint.baseUrl}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                <span>
                  {t('admin.ai.apiKey')}
                  <span
                    className={`block text-[12px] ${sameProvider && unreadable ? 'text-error' : 'text-index'}`}
                  >
                    {sameProvider && unreadable
                      ? t('admin.ai.apiKeyUnreadable')
                      : sameProvider && value?.apiKey
                        ? t('admin.ai.apiKeyCurrent', { key: value.apiKey })
                        : provider === 'openai'
                          ? t('admin.ai.apiKeyOptional')
                          : t('admin.ai.apiKeyConsole')}
                  </span>
                </span>
                <input
                  className="input w-72 font-mono"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button className="btn btn-primary">{t('common.save')}</button>
            {value && (
              <button type="button" className="btn btn-ghost" onClick={test} disabled={testing}>
                {testing ? t('admin.ai.testing') : t('admin.ai.test')}
              </button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

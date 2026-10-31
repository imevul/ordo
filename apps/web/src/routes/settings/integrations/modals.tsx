import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { useEffect, useState } from 'react';
import { api, wsPath } from '../../../api/client.ts';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { ChatForm, chatForms, SlackAppPanel } from '../chat/index.tsx';
import { EmailForm } from '../email-intake.tsx';
import { JiraForm } from '../jira.tsx';
import { GithubAppPanel } from './github-app.tsx';
import { TokenForm, tokenForms } from './token-form.tsx';

export function ConnectModal({
  provider,
  onClose,
  onDone,
}: {
  provider: IntegrationProviderInfo | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<'app' | 'token'>('app');
  // biome-ignore lint/correctness/useExhaustiveDependencies: start each provider on its first tab
  useEffect(() => setTab('app'), [provider]);
  if (!provider) return null;
  const isGithub = provider.key === 'github';
  const isSlack = provider.key === 'slack';
  const tabs: [string, string][] | null = isGithub
    ? [
        ['app', 'GitHub App'],
        ['token', t('integrations.connect.accessTokenTab')],
      ]
    : isSlack
      ? [
          ['app', t('integrations.slackApp.tab')],
          ['token', t('integrations.slackApp.manualTab')],
        ]
      : null;
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      label={t('integrations.connect.title', { provider: provider.name })}
      align="center"
    >
      <div className="max-h-[82vh] overflow-y-auto p-6">
        <div className="section-label mb-4">
          {t('integrations.connect.title', { provider: provider.name })}
        </div>
        {tabs && (
          <div className="mb-5 flex gap-1 border-b border-border-soft">
            {tabs.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`-mb-px border-b-2 px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] uppercase ${tab === k ? 'border-primary text-text' : 'border-transparent text-index hover:text-text'}`}
                onClick={() => setTab(k as 'app' | 'token')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {isGithub && tab === 'app' ? (
          <GithubAppPanel onCancel={onClose} />
        ) : isSlack && tab === 'app' ? (
          <SlackAppPanel onCancel={onClose} />
        ) : provider.key === 'email' ? (
          <EmailForm provider={provider} onDone={onDone} onCancel={onClose} />
        ) : provider.key === 'jira' ? (
          <JiraForm provider={provider} onDone={onDone} onCancel={onClose} />
        ) : chatForms()[provider.key] ? (
          <ChatForm provider={provider} onDone={onDone} onCancel={onClose} />
        ) : tokenForms()[provider.key] ? (
          <TokenForm provider={provider} onDone={onDone} onCancel={onClose} />
        ) : (
          <p className="text-muted">{t('integrations.connect.setUpElsewhere')}</p>
        )}
      </div>
    </Modal>
  );
}

export function EditModal({
  integration,
  onClose,
  onDone,
}: {
  integration: Integration | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const ws = useWorkspace();
  const [comment, setComment] = useState(false);
  useEffect(() => {
    setComment(
      (integration?.config as { commentOnPullRequests?: boolean })?.commentOnPullRequests === true,
    );
  }, [integration]);
  if (!integration) return null;
  const app = (integration.config as { mode?: string }).mode === 'app';
  const chat = !!chatForms()[integration.provider];
  const info: IntegrationProviderInfo = {
    key: integration.provider,
    name: integration.name,
    description: '',
    category: chat ? 'chat' : 'forge',
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      label={t('integrations.edit.label', { name: integration.name })}
      align="center"
    >
      <div className="max-h-[82vh] overflow-y-auto p-6">
        <div className="section-label mb-4">{integration.name}</div>
        {integration.inboundUrl && (
          <div className="mb-5 border border-border-soft bg-bg p-3">
            <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              {t('integrations.edit.webhookUrl')}
            </div>
            <code className="block truncate font-mono text-[12px]">{integration.inboundUrl}</code>
          </div>
        )}
        {integration.provider === 'email' ? (
          <EmailForm provider={info} existing={integration} onDone={onDone} onCancel={onClose} />
        ) : integration.provider === 'jira' ? (
          <JiraForm provider={info} existing={integration} onDone={onDone} onCancel={onClose} />
        ) : chat ? (
          <ChatForm provider={info} existing={integration} onDone={onDone} onCancel={onClose} />
        ) : app ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await api.patch(wsPath(ws.slug, `/integrations/${integration.id}`), {
                config: { commentOnPullRequests: comment },
              });
              onDone();
            }}
          >
            <p className="mb-4 text-[12.5px] text-muted">{t('integrations.edit.appRepos')}</p>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-primary"
                checked={comment}
                onChange={(e) => setComment(e.target.checked)}
              />
              {t('integrations.forge.commentOnPullRequests')}
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary">{t('common.save')}</button>
            </div>
          </form>
        ) : (
          <TokenForm provider={info} existing={integration} onDone={onDone} onCancel={onClose} />
        )}
      </div>
    </Modal>
  );
}

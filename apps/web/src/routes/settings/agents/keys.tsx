import type { Agent } from '@ordo/shared';
import { Copy } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { copy, errMsg } from './shared.ts';

export function KeyModal({
  agent,
  onClose,
  onCreated,
}: {
  agent: Agent | null;
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (agent) setName('');
  }, [agent]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>(wsPath(ws.slug, `/agents/${agent.id}/keys`), {
        name,
      });
      onCreated(res.token);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!agent} onClose={onClose} width={480} label={t('agents.newKey')} align="center">
      <form className="p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {t('agents.newKey')} · {agent?.name}
        </div>
        <FormRow label={t('agents.keys.name')}>
          <input
            className="input"
            required
            autoFocus
            maxLength={120}
            placeholder={t('agents.keys.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {t('agents.keys.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TokenModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  const ws = useWorkspace();
  const origin = location.origin;
  const command = `ordo agent run --url ${origin} -w ${ws.slug} --key ${token} -- claude -p`;
  const file = `# agents.yaml — ordo agent run --file agents.yaml\nurl: ${origin}\nworkspace: ${ws.slug}\nkey: \${AGENT_KEY}   # AGENT_KEY=… in .env\ncommand: [claude, -p]`;
  return (
    <Modal
      open={!!token}
      onClose={onClose}
      width={640}
      label={t('agents.token.title')}
      align="center"
    >
      <div className="p-6">
        <div className="section-label mb-4">{t('agents.token.title')}</div>
        <div className="mb-4 flex items-center gap-2 border border-border-soft bg-bg p-3">
          <code className="flex-1 truncate font-mono text-[12.5px]">{token}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(token!)}>
            <Copy size={12} /> {t('common.copy')}
          </button>
        </div>
        <p className="mb-2 text-[13px] text-muted">{t('agents.token.body')}</p>
        <Snippet text={command} />
        <p className="mt-4 mb-2 text-[13px] text-muted">{t('agents.token.fileHint')}</p>
        <Snippet text={file} />
        <div className="mt-6 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto border border-border-soft bg-bg p-3 pr-12 font-mono text-[11.5px] whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        className="btn btn-ghost btn-sm absolute top-1.5 right-1.5"
        aria-label={t('common.copy')}
        onClick={() => copy(text)}
      >
        <Copy size={12} />
      </button>
    </div>
  );
}

import { isGuestRole } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys } from '../../../api/queries.ts';
import { confirmDialog, Modal } from '../../../components/ui/Modal.tsx';
import { t, tx } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg } from './shared.ts';

export function DangerZone() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [heir, setHeir] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const candidates = ws.members.filter(
    (m) => m.id !== ws.me.id && !isGuestRole(m.role) && !m.suspended,
  );

  return (
    <SettingsCard title={t('workspaceSettings.danger.title')}>
      <div className="mb-6">
        <div className="mb-2 text-[13.5px]">{t('workspaceSettings.danger.transferOwnership')}</div>
        <div className="flex flex-wrap gap-2">
          <select className="input w-72" value={heir} onChange={(e) => setHeir(e.target.value)}>
            <option value="">{t('workspaceSettings.danger.chooseMember')}</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {t('workspaceSettings.danger.memberOption', {
                  name: m.name,
                  role: roleLabel(m.role),
                })}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!heir}
            onClick={async () => {
              const who = ws.memberById.get(heir)?.name;
              if (
                !(await confirmDialog({
                  title: t('workspaceSettings.danger.transferTitle', { name: who ?? '' }),
                  body: t('workspaceSettings.danger.transferBody'),
                  confirmLabel: t('workspaceSettings.danger.transferOwnership'),
                  danger: true,
                }))
              )
                return;
              try {
                await api.post(wsPath(ws.slug, '/transfer-ownership'), {
                  userId: heir,
                  stepDown: true,
                });
                toast.success(
                  t('workspaceSettings.danger.transferred', {
                    name: who ?? '',
                    workspace: ws.workspace.name,
                  }),
                );
                qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            {t('workspaceSettings.danger.transfer')}
          </button>
        </div>
      </div>
      <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
        <Trash2 size={13} /> {t('workspaceSettings.danger.deleteWorkspace')}
      </button>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        width={460}
        label={t('workspaceSettings.danger.deleteWorkspace')}
        align="center"
      >
        <form
          className="p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.del(wsPath(ws.slug, '/'), { confirmSlug: confirm });
              qc.clear();
              navigate({ to: '/' });
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <div className="section-label mb-4">{t('workspaceSettings.danger.careful')}</div>
          <h2 className="text-lg font-bold tracking-tight">
            {t('workspaceSettings.danger.deleteTitle', { name: ws.workspace.name })}
          </h2>
          <p className="mt-2 text-[13.5px] text-muted">
            {tx('workspaceSettings.danger.deleteBody', {
              slug: ws.slug,
              code: (c) => <span className="font-mono text-text">{c}</span>,
            })}
          </p>
          <input
            className="input mt-4 font-mono"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoFocus
          />
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" disabled={confirm !== ws.slug}>
              {t('workspaceSettings.danger.deleteForever')}
            </button>
          </div>
        </form>
      </Modal>
    </SettingsCard>
  );
}

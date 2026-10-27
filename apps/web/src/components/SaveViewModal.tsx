import type { IssueDisplay, IssueFilter, View } from '@ordo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Modal } from './ui/Modal.tsx';

export function SaveViewModal({
  open,
  onClose,
  filters,
  display,
  teamId,
}: {
  open: boolean;
  onClose: () => void;
  filters: IssueFilter;
  display: IssueDisplay;
  teamId?: string;
}) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(true);
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<View>(wsPath(ws.slug, '/views'), body),
    { success: t('issues.saveView.created') },
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name, shared, filters, display, teamId: teamId ?? null },
      {
        onSuccess: (view) => {
          onClose();
          setName('');
          navigate({ to: '/$slug/view/$viewId', params: { slug: ws.slug, viewId: view.id } });
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={460}
      label={t('issues.saveView.submit')}
      align="center"
    >
      <form onSubmit={submit} className="p-6">
        <div className="section-label mb-4">{t('issues.saveView.title')}</div>
        <label className="block text-[12px] text-muted">
          {t('issues.saveView.name')}
          <input
            className="input mt-1"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('issues.saveView.namePlaceholder')}
          />
        </label>
        <label className="mt-4 flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
            className="accent-primary"
          />
          {t('issues.saveView.share')}
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            {t('issues.saveView.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

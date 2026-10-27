import {
  DOMAIN_EVENT_TYPES,
  type DomainEventType,
  type Webhook,
  type WebhookDelivery,
  type WebhookPayload,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, Pencil, Plus, Radio, RotateCcw, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { TeamIcon } from '../../components/icons.tsx';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t, tx } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success(t('common.copied'));
};

export function WebhooksSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'webhooks'];
  const { data: hooks } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Webhook[]>(wsPath(ws.slug, '/webhooks')),
    enabled: ws.isAdmin,
  });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });

  if (!ws.isAdmin) return <p className="text-muted">{t('webhooks.adminsOnly')}</p>;
  if (!hooks) return <Spinner />;

  return (
    <>
      <SettingsCard
        title={t('webhooks.title')}
        description={tx('webhooks.description', {
          header: <code className="font-mono text-text">Ordo-Signature</code>,
          format: <code className="font-mono">t=…,v1=…</code>,
          signed: <code className="font-mono">{'"<t>.<body>"'}</code>,
        })}
      >
        {hooks.map((h) => (
          <div key={h.id} className="border-b border-border-soft py-3">
            <div className="flex items-center gap-3">
              <Radio
                size={14}
                className={`flex-none ${h.enabled ? 'text-highlight' : 'text-index'}`}
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setOpen(open === h.id ? null : h.id)}
              >
                <div className="truncate font-mono text-[12.5px]">{h.url}</div>
                <div className="truncate text-[11.5px] text-index">
                  {h.description || t('webhooks.noDescription')} ·{' '}
                  {h.eventTypes.length
                    ? t('webhooks.eventCount', { count: h.eventTypes.length })
                    : t('webhooks.allEvents')}{' '}
                  ·{' '}
                  {h.teamIds.length
                    ? t('webhooks.teamCount', { count: h.teamIds.length })
                    : t('webhooks.allTeams')}
                  {h.lastDeliveryAt &&
                    ` · ${t('webhooks.lastDelivery', {
                      status: h.lastStatus ?? t('webhooks.error'),
                      time: relativeTime(h.lastDeliveryAt),
                    })}`}
                </div>
              </button>
              {h.enabled ? (
                <span className="chip [--chip:var(--color-success)]">{t('webhooks.on')}</span>
              ) : (
                <span className="tag font-mono">{t('webhooks.off')}</span>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('webhooks.sendTest')}
                title={t('webhooks.sendPing')}
                onClick={async () => {
                  try {
                    await api.post(wsPath(ws.slug, `/webhooks/${h.id}/ping`));
                    toast.success(t('webhooks.pingQueued'));
                    setOpen(h.id);
                    setTimeout(
                      () => qc.invalidateQueries({ queryKey: ['ws', ws.slug, 'deliveries', h.id] }),
                      1500,
                    );
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <Send size={12} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('webhooks.editLabel', { url: h.url })}
                onClick={() => setEditing(h)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label={t('webhooks.deleteLabel', { url: h.url })}
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: t('webhooks.confirmDelete', { url: h.url }),
                      danger: true,
                    }))
                  )
                    return;
                  await api.del(wsPath(ws.slug, `/webhooks/${h.id}`));
                  reload();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {h.disabledReason && (
              <p className="mt-2 text-[12px] text-warning">
                {t('webhooks.disabledReason', { reason: h.disabledReason })}
              </p>
            )}
            {open === h.id && <Deliveries hook={h} />}
          </div>
        ))}
        {hooks.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('webhooks.empty')}</p>
        )}
        <button type="button" className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={13} /> {t('webhooks.addWebhook')}
        </button>
      </SettingsCard>

      <WebhookModal
        hook={editing}
        onClose={() => setEditing(null)}
        onSaved={(newSecret) => {
          setEditing(null);
          if (newSecret) setSecret(newSecret);
          reload();
        }}
      />
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        width={520}
        label={t('webhooks.secret.title')}
        align="center"
      >
        <div className="p-6">
          <div className="section-label mb-4">{t('webhooks.secret.title')}</div>
          <p className="mb-3 text-[13.5px] text-muted">{t('webhooks.secret.body')}</p>
          <div className="flex items-center gap-2 border border-border-soft bg-bg p-3">
            <code className="flex-1 truncate font-mono text-[12.5px]">{secret}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(secret!)}>
              <Copy size={12} /> {t('common.copy')}
            </button>
          </div>
          <div className="mt-6 flex justify-end">
            <button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>
              {t('common.done')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

const STATUS_COLOR: Record<WebhookDelivery['status'], string> = {
  success: 'var(--color-success)',
  pending: 'var(--color-warning)',
  failed: 'var(--color-error)',
};

function Deliveries({ hook }: { hook: Webhook }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'deliveries', hook.id];
  const { data = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WebhookDelivery[]>(wsPath(ws.slug, `/webhooks/${hook.id}/deliveries`)),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'pending') ? 3000 : false),
  });
  const [shown, setShown] = useState<(WebhookDelivery & { payload: WebhookPayload }) | null>(null);
  return (
    <div className="mt-3 border border-border-soft bg-bg">
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
        <span className="flex-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
          {t('webhooks.deliveries.title')}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            const { secret } = await api.get<{ secret: string }>(
              wsPath(ws.slug, `/webhooks/${hook.id}/secret`),
            );
            copy(secret);
          }}
        >
          <Eye size={12} /> {t('webhooks.deliveries.copySecret')}
        </button>
      </div>
      {isLoading && <Spinner />}
      {data.map((d) => (
        <div
          key={d.id}
          className="flex h-9 items-center gap-3 border-b border-border-soft/60 px-3 last:border-0"
        >
          <span className="h-2 w-2 flex-none" style={{ background: STATUS_COLOR[d.status] }} />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono text-[12px] hover:text-highlight"
            onClick={async () =>
              setShown(await api.get(wsPath(ws.slug, `/webhooks/${hook.id}/deliveries/${d.id}`)))
            }
          >
            {d.eventType}
          </button>
          <span className="font-mono text-[11px] text-index">
            {d.responseStatus ?? (d.error ? t('webhooks.error') : '…')}
            {d.attempts > 1 && ` · ${t('webhooks.deliveries.tries', { count: d.attempts })}`}
            {d.durationMs !== null && ` · ${d.durationMs}ms`} · {relativeTime(d.createdAt)}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('webhooks.deliveries.redeliver')}
            title={t('webhooks.deliveries.redeliver')}
            disabled={!hook.enabled}
            onClick={async () => {
              try {
                await api.post(
                  wsPath(ws.slug, `/webhooks/${hook.id}/deliveries/${d.id}/redeliver`),
                );
                setTimeout(() => qc.invalidateQueries({ queryKey: key }), 1000);
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <RotateCcw size={12} />
          </button>
        </div>
      ))}
      {!isLoading && data.length === 0 && (
        <p className="px-3 py-3 font-mono text-[12px] text-index">
          {t('webhooks.deliveries.empty')}
        </p>
      )}
      <Modal
        open={!!shown}
        onClose={() => setShown(null)}
        width={720}
        label={t('webhooks.deliveries.delivery')}
        align="center"
      >
        {shown && (
          <div className="max-h-[80vh] overflow-y-auto p-6">
            <div className="section-label mb-2">{shown.eventType}</div>
            <p className="mb-4 font-mono text-[11.5px] text-index">
              {t(`webhooks.deliveries.status.${shown.status}`)} ·{' '}
              {shown.responseStatus ?? shown.error ?? t('webhooks.deliveries.noResponse')} ·{' '}
              {t('webhooks.deliveries.attempts', { count: shown.attempts })}
            </p>
            <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              {t('webhooks.deliveries.request')}
            </div>
            <pre className="mb-4 max-h-80 overflow-auto border border-border-soft bg-bg p-3 font-mono text-[11.5px] whitespace-pre-wrap">
              {JSON.stringify(shown.payload, null, 2)}
            </pre>
            <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              {t('webhooks.deliveries.response')}
            </div>
            <pre className="max-h-48 overflow-auto border border-border-soft bg-bg p-3 font-mono text-[11.5px] whitespace-pre-wrap">
              {shown.error ?? shown.responseBody ?? '—'}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

const EVENT_GROUPS = [...new Set(DOMAIN_EVENT_TYPES.map((type) => type.split('.')[0]!))];

function WebhookModal({
  hook,
  onClose,
  onSaved,
}: {
  hook: Webhook | 'new' | null;
  onClose: () => void;
  onSaved: (secret?: string) => void;
}) {
  const ws = useWorkspace();
  const existing = hook && hook !== 'new' ? hook : null;
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<DomainEventType[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!hook) return;
    setUrl(existing?.url ?? '');
    setDescription(existing?.description ?? '');
    setEvents(existing?.eventTypes ?? []);
    setTeamIds(existing?.teamIds ?? []);
    setEnabled(existing?.enabled ?? true);
  }, [hook, existing]);
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = { url, description, eventTypes: events, teamIds, enabled };
    try {
      if (existing) {
        await api.patch(wsPath(ws.slug, `/webhooks/${existing.id}`), body);
        onSaved();
      } else {
        const res = await api.post<{ secret: string }>(wsPath(ws.slug, '/webhooks'), body);
        onSaved(res.secret);
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!hook}
      onClose={onClose}
      width={600}
      label={t('webhooks.form.label')}
      align="center"
    >
      <form className="max-h-[82vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('webhooks.form.edit') : t('webhooks.form.new')}
        </div>
        <FormRow label={t('webhooks.form.url')}>
          <input
            className="input font-mono"
            type="url"
            required
            autoFocus
            placeholder="https://example.com/ordo-events"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </FormRow>
        <FormRow label={t('webhooks.form.description')}>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormRow>
        <div className="mb-1 text-[12px] text-muted">{t('webhooks.form.events')}</div>
        <label className="mb-2 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-primary"
            checked={events.length === 0}
            onChange={() => setEvents(events.length ? [] : ['issue.created'])}
          />
          {t('webhooks.form.everything')}
        </label>
        {events.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 border border-border-soft p-3 sm:grid-cols-3">
            {EVENT_GROUPS.flatMap((g) =>
              DOMAIN_EVENT_TYPES.filter((type) => type.startsWith(`${g}.`)).map((type) => (
                <label key={type} className="flex items-center gap-2 font-mono text-[11.5px]">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={events.includes(type)}
                    onChange={() => setEvents(toggle(events, type))}
                  />
                  {type}
                </label>
              )),
            )}
          </div>
        )}
        <div className="mt-3 mb-1 text-[12px] text-muted">{t('webhooks.form.teams')}</div>
        <label className="mb-2 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-primary"
            checked={teamIds.length === 0}
            onChange={() => setTeamIds(teamIds.length ? [] : [ws.teams[0]!.id])}
          />
          {t('webhooks.form.allTeams')}
        </label>
        {teamIds.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-3 border border-border-soft p-3">
            {ws.teams.map((team) => (
              <label key={team.id} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={teamIds.includes(team.id)}
                  onChange={() => setTeamIds(toggle(teamIds, team.id))}
                />
                <TeamIcon color={team.color} label={team.key} size={14} /> {team.name}
              </label>
            ))}
          </div>
        )}
        <label className="mt-3 flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-primary"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('webhooks.form.active')}
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? t('common.save') : t('webhooks.addWebhook')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

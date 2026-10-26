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
import { Modal } from '../../components/ui/Modal.tsx';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './index.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success('Copied');
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

  if (!ws.isAdmin) return <p className="text-muted">Only admins can manage webhooks.</p>;
  if (!hooks) return <Spinner />;

  return (
    <>
      <SettingsCard
        title="Webhooks"
        description={
          <>
            Ordo POSTs a JSON event to your URL when issues, comments, projects and cycles change.
            Each request is signed: verify{' '}
            <code className="font-mono text-text">Ordo-Signature</code> (
            <code className="font-mono">t=…,v1=…</code>, an HMAC-SHA256 of{' '}
            <code className="font-mono">{'"<t>.<body>"'}</code> with the webhook's secret). Failed
            deliveries are retried for about an hour.
          </>
        }
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
                  {h.description || 'No description'} ·{' '}
                  {h.eventTypes.length ? `${h.eventTypes.length} events` : 'all events'} ·{' '}
                  {h.teamIds.length ? `${h.teamIds.length} teams` : 'all teams'}
                  {h.lastDeliveryAt &&
                    ` · last ${h.lastStatus ?? 'error'} ${relativeTime(h.lastDeliveryAt)}`}
                </div>
              </button>
              {h.enabled ? (
                <span className="chip [--chip:var(--color-success)]">on</span>
              ) : (
                <span className="tag font-mono">off</span>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="Send a test event"
                title="Send a ping"
                onClick={async () => {
                  try {
                    await api.post(wsPath(ws.slug, `/webhooks/${h.id}/ping`));
                    toast.success('Ping queued');
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
                aria-label={`Edit ${h.url}`}
                onClick={() => setEditing(h)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label={`Delete ${h.url}`}
                onClick={async () => {
                  if (!confirm(`Delete the webhook to ${h.url}?`)) return;
                  await api.del(wsPath(ws.slug, `/webhooks/${h.id}`));
                  reload();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {h.disabledReason && (
              <p className="mt-2 text-[12px] text-warning">
                {h.disabledReason}. Fix the endpoint, then switch it back on.
              </p>
            )}
            {open === h.id && <Deliveries hook={h} />}
          </div>
        ))}
        {hooks.length === 0 && (
          <p className="font-mono text-[12px] text-index">// no webhooks yet</p>
        )}
        <button type="button" className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={13} /> Add webhook
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
        label="Signing secret"
        align="center"
      >
        <div className="p-6">
          <div className="section-label mb-4">Signing secret</div>
          <p className="mb-3 text-[13.5px] text-muted">
            Use this to verify that requests come from Ordo. You can see it again later from the
            webhook's settings.
          </p>
          <div className="flex items-center gap-2 border border-border-soft bg-bg p-3">
            <code className="flex-1 truncate font-mono text-[12.5px]">{secret}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(secret!)}>
              <Copy size={12} /> Copy
            </button>
          </div>
          <div className="mt-6 flex justify-end">
            <button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>
              Done
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
          Recent deliveries
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
          <Eye size={12} /> Copy secret
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
            {d.responseStatus ?? (d.error ? 'error' : '…')}
            {d.attempts > 1 && ` · ${d.attempts} tries`}
            {d.durationMs !== null && ` · ${d.durationMs}ms`} · {relativeTime(d.createdAt)}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Redeliver"
            title="Redeliver"
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
        <p className="px-3 py-3 font-mono text-[12px] text-index">// nothing delivered yet</p>
      )}
      <Modal
        open={!!shown}
        onClose={() => setShown(null)}
        width={720}
        label="Delivery"
        align="center"
      >
        {shown && (
          <div className="max-h-[80vh] overflow-y-auto p-6">
            <div className="section-label mb-2">{shown.eventType}</div>
            <p className="mb-4 font-mono text-[11.5px] text-index">
              {shown.status} · {shown.responseStatus ?? shown.error ?? 'no response'} ·{' '}
              {shown.attempts} attempt{shown.attempts === 1 ? '' : 's'}
            </p>
            <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              Request
            </div>
            <pre className="mb-4 max-h-80 overflow-auto border border-border-soft bg-bg p-3 font-mono text-[11.5px] whitespace-pre-wrap">
              {JSON.stringify(shown.payload, null, 2)}
            </pre>
            <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              Response
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

const EVENT_GROUPS = [...new Set(DOMAIN_EVENT_TYPES.map((t) => t.split('.')[0]!))];

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
    <Modal open={!!hook} onClose={onClose} width={600} label="Webhook" align="center">
      <form className="max-h-[82vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">{existing ? 'Edit webhook' : 'New webhook'}</div>
        <FormRow label="Payload URL">
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
        <FormRow label="Description">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormRow>
        <div className="mb-1 text-[12px] text-muted">Events</div>
        <label className="mb-2 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-[#ff1493]"
            checked={events.length === 0}
            onChange={() => setEvents(events.length ? [] : ['issue.created'])}
          />
          Everything
        </label>
        {events.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 border border-border-soft p-3 sm:grid-cols-3">
            {EVENT_GROUPS.flatMap((g) =>
              DOMAIN_EVENT_TYPES.filter((t) => t.startsWith(`${g}.`)).map((t) => (
                <label key={t} className="flex items-center gap-2 font-mono text-[11.5px]">
                  <input
                    type="checkbox"
                    className="accent-[#ff1493]"
                    checked={events.includes(t)}
                    onChange={() => setEvents(toggle(events, t))}
                  />
                  {t}
                </label>
              )),
            )}
          </div>
        )}
        <div className="mt-3 mb-1 text-[12px] text-muted">Teams</div>
        <label className="mb-2 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-[#ff1493]"
            checked={teamIds.length === 0}
            onChange={() => setTeamIds(teamIds.length ? [] : [ws.teams[0]!.id])}
          />
          All teams
        </label>
        {teamIds.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-3 border border-border-soft p-3">
            {ws.teams.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-[#ff1493]"
                  checked={teamIds.includes(t.id)}
                  onChange={() => setTeamIds(toggle(teamIds, t.id))}
                />
                <TeamIcon color={t.color} label={t.key} size={14} /> {t.name}
              </label>
            ))}
          </div>
        )}
        <label className="mt-3 flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-[#ff1493]"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Active
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? 'Save' : 'Add webhook'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

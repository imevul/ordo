import type { Customer, CustomerRequestWithIssue } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Building2, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { StatusIcon } from '../components/icons.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { assigneeOptions, Picker } from '../components/properties.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { confirmDialog, Modal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

export const parseDomains = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

function NewCustomerModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const create = useWsMutation(ws.slug, (body: object) =>
    api.post<Customer>(wsPath(ws.slug, '/customers'), body),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name, domains: parseDomains(domains) },
      {
        onSuccess: (c) => {
          onClose();
          navigate({
            to: '/$slug/customer/$customerId',
            params: { slug: ws.slug, customerId: c.id },
          });
        },
      },
    );
  };
  return (
    <Modal open onClose={onClose} width={480} label={t('customers.create.title')}>
      <form className="p-5" onSubmit={submit}>
        <div className="section-label mb-4">{t('customers.create.title')}</div>
        <input
          className="input"
          placeholder={t('customers.create.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input mt-3 font-mono"
          placeholder={t('customers.create.domainsPlaceholder', { example: 'acme.com' })}
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
        <p className="mt-1.5 text-[12px] text-index">{t('customers.create.domainsHint')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            {t('customers.create.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Who asks for what: customers with their requests and open issues. */
export function CustomersPage() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const list = [...ws.customers].sort(
    (a, b) => b.openIssueCount - a.openIssueCount || a.name.localeCompare(b.name),
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('customers.list.kicker')}
          </>
        }
        title={t('customers.list.title')}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={13} /> {t('customers.list.newCustomer')}
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <EmptyState title={t('customers.list.emptyTitle')} body={t('customers.list.emptyBody')} />
        ) : (
          <div className="min-w-[780px]">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_8rem_7rem_6rem] items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              <span>{t('customers.list.name')}</span>
              <span>{t('customers.list.domains')}</span>
              <span>{t('customers.list.owner')}</span>
              <span>{t('customers.list.requests')}</span>
              <span>{t('customers.list.open')}</span>
            </div>
            {list.map((c) => {
              const owner = c.ownerId ? ws.memberById.get(c.ownerId) : null;
              return (
                <Link
                  key={c.id}
                  to="/$slug/customer/$customerId"
                  params={{ slug: ws.slug, customerId: c.id }}
                  className="row grid h-11 grid-cols-[minmax(0,1fr)_minmax(0,12rem)_8rem_7rem_6rem] items-center gap-3 border-b border-border-soft/60 px-4"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Building2 size={14} className="flex-none text-index" />
                    <span className="truncate text-[13.5px]">{c.name}</span>
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-muted">
                    {c.domains.join(', ') || '—'}
                  </span>
                  <span className="truncate text-[12.5px] text-muted">
                    {owner?.name.split(' ')[0] ?? '—'}
                  </span>
                  <span className="font-mono text-[11.5px] text-muted">{c.requestCount}</span>
                  <span className="font-mono text-[11.5px] text-text">{c.openIssueCount}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      {open && <NewCustomerModal onClose={() => setOpen(false)} />}
    </div>
  );
}

export function CustomerPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { customerId } = useParams({ from: '/$slug/customer/$customerId' });
  const customer = ws.customers.find((c) => c.id === customerId);
  const { data: requests = [] } = useQuery({
    queryKey: ['ws', ws.slug, 'customerRequests', customerId],
    queryFn: () =>
      api.get<CustomerRequestWithIssue[]>(wsPath(ws.slug, `/customers/${customerId}/requests`)),
  });
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/customers/${customerId}`), body),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/customers/${customerId}`)));
  const [name, setName] = useState(customer?.name ?? '');
  const [domains, setDomains] = useState(customer?.domains.join(', ') ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  useEffect(() => {
    setName(customer?.name ?? '');
    setDomains(customer?.domains.join(', ') ?? '');
    setNotes(customer?.notes ?? '');
  }, [customer?.name, customer?.domains, customer?.notes]);
  if (!customer) return <EmptyState title={t('customers.detail.notFound')} />;
  const owner = customer.ownerId ? ws.memberById.get(customer.ownerId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            <Link to="/$slug/customers" params={{ slug: ws.slug }} className="hover:text-highlight">
              {t('customers.detail.kicker')}
            </Link>
            <Sep />
            {customer.domains[0] ?? t('customers.detail.customer')}
          </>
        }
        title={customer.name}
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('customers.detail.delete')}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('customers.detail.confirmDeleteTitle', { name: customer.name }),
                  body: t('customers.detail.confirmDeleteBody'),
                  danger: true,
                })
              )
                remove.mutate(undefined, {
                  onSuccess: () => navigate({ to: '/$slug/customers', params: { slug: ws.slug } }),
                });
            }}
          >
            <Trash2 size={13} />
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 py-8 lg:grid-cols-[1fr_16rem]">
          <div className="min-w-0">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== customer.name && save.mutate({ name })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-full bg-transparent text-[28px] font-bold tracking-[-0.02em] outline-none"
              aria-label={t('customers.detail.nameLabel')}
            />
            <div className="section-label mt-8 mb-2">
              {t('customers.detail.requests', { count: requests.length })}
            </div>
            {requests.length === 0 && (
              <p className="font-mono text-[12px] text-index">{t('customers.detail.noRequests')}</p>
            )}
            {requests.map((r) => {
              const state = ws.stateById.get(r.issue.stateId);
              return (
                <div key={r.id} className="border-b border-border-soft py-3">
                  <Link
                    to="/$slug/issue/$identifier"
                    params={{ slug: ws.slug, identifier: r.issue.identifier }}
                    className="flex min-w-0 items-center gap-2 hover:text-highlight"
                  >
                    {state && <StatusIcon type={state.type} color={state.color} />}
                    <span className="font-mono text-[11.5px] text-index">{r.issue.identifier}</span>
                    <span className="truncate text-[13.5px]">{r.issue.title}</span>
                  </Link>
                  {r.body && (
                    <blockquote className="mt-1.5 border-l border-border pl-3 text-[13px] whitespace-pre-wrap text-muted">
                      {r.body}
                    </blockquote>
                  )}
                  <div className="mt-1 font-mono text-[11px] text-index">
                    {r.contact ?? t('customers.detail.noContact')} ·{' '}
                    {t(`customers.detail.source.${r.source}`)} · {relativeTime(r.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
          <aside>
            <div className="section-label mb-3">{t('customers.detail.details')}</div>
            <div className="flex flex-col gap-3 text-[12.5px]">
              <label className="block text-index">
                {t('customers.detail.domains')}
                <input
                  className="input mt-1 h-8 font-mono"
                  value={domains}
                  placeholder="acme.com"
                  onChange={(e) => setDomains(e.target.value)}
                  onBlur={() => save.mutate({ domains: parseDomains(domains) })}
                />
              </label>
              <div className="text-index">
                {t('customers.detail.owner')}
                <div className="mt-1">
                  <Picker
                    placeholder={t('customers.detail.setOwner')}
                    options={assigneeOptions(ws)}
                    selected={[customer.ownerId ?? 'none']}
                    onSelect={(v) => save.mutate({ ownerId: v === 'none' ? null : v })}
                    trigger={
                      <button type="button" className="prop w-full justify-start">
                        {owner ? (
                          <Avatar
                            name={owner.name}
                            color={owner.avatarColor}
                            src={owner.avatarUrl}
                            size={16}
                          />
                        ) : null}
                        {owner?.name ?? t('customers.detail.noOwner')}
                      </button>
                    }
                  />
                </div>
              </div>
              <label className="block text-index">
                {t('customers.detail.notes')}
                <textarea
                  className="input mt-1 min-h-24 resize-y py-2"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() =>
                    notes !== (customer.notes ?? '') && save.mutate({ notes: notes || null })
                  }
                />
              </label>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

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
    <Modal open onClose={onClose} width={480} label="New customer">
      <form className="p-5" onSubmit={submit}>
        <div className="section-label mb-4">New customer</div>
        <input
          className="input"
          placeholder="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input mt-3 font-mono"
          placeholder="Email domains, e.g. acme.com"
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
        <p className="mt-1.5 text-[12px] text-index">
          Email from these domains is filed under this customer.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            Create customer <span className="arrow">→</span>
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
            customers
          </>
        }
        title="Customers"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={13} /> New customer
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <EmptyState
            title="no customers yet"
            body="Customers collect requests: what they asked for, tied to the issues that deliver it. Email intake adds them on its own."
          />
        ) : (
          <div className="min-w-[640px]">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_8rem_6rem_6rem] items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              <span>Name</span>
              <span>Domains</span>
              <span>Owner</span>
              <span>Requests</span>
              <span>Open</span>
            </div>
            {list.map((c) => {
              const owner = c.ownerId ? ws.memberById.get(c.ownerId) : null;
              return (
                <Link
                  key={c.id}
                  to="/$slug/customer/$customerId"
                  params={{ slug: ws.slug, customerId: c.id }}
                  className="row grid h-11 grid-cols-[minmax(0,1fr)_minmax(0,12rem)_8rem_6rem_6rem] items-center gap-3 border-b border-border-soft/60 px-4"
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
  if (!customer) return <EmptyState title="customer not found" />;
  const owner = customer.ownerId ? ws.memberById.get(customer.ownerId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            <Link to="/$slug/customers" params={{ slug: ws.slug }} className="hover:text-highlight">
              customers
            </Link>
            <Sep />
            {customer.domains[0] ?? 'customer'}
          </>
        }
        title={customer.name}
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Delete customer"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: `Delete customer “${customer.name}”?`,
                  body: 'Their requests go too; the issues stay.',
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
              aria-label="Customer name"
            />
            <div className="section-label mt-8 mb-2">Requests · {requests.length}</div>
            {requests.length === 0 && (
              <p className="font-mono text-[12px] text-index">// no requests yet</p>
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
                    {r.contact ?? 'no contact'} · {r.source} · {relativeTime(r.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
          <aside>
            <div className="section-label mb-3">Details</div>
            <div className="flex flex-col gap-3 text-[12.5px]">
              <label className="block text-index">
                Domains
                <input
                  className="input mt-1 h-8 font-mono"
                  value={domains}
                  placeholder="acme.com"
                  onChange={(e) => setDomains(e.target.value)}
                  onBlur={() => save.mutate({ domains: parseDomains(domains) })}
                />
              </label>
              <div className="text-index">
                Owner
                <div className="mt-1">
                  <Picker
                    placeholder="Set owner…"
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
                        {owner?.name ?? 'No owner'}
                      </button>
                    }
                  />
                </div>
              </div>
              <label className="block text-index">
                Notes
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

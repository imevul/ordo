import type { IssueDetail } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { Building2, Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Popover } from './ui/Popover.tsx';

/** Which customers asked for this issue, and what they said. Not shown to guests. */
export function CustomerRequests({
  issue,
  onChange,
}: {
  issue: IssueDetail;
  onChange: () => void;
}) {
  const ws = useWorkspace();
  const add = useWsMutation(ws.slug, (v: { customerId: string; body: string; contact?: string }) =>
    api.post(wsPath(ws.slug, `/issues/${issue.id}/customer-requests`), v),
  );
  const create = useWsMutation(ws.slug, (name: string) =>
    api.post<{ id: string }>(wsPath(ws.slug, '/customers'), { name }),
  );
  const remove = useWsMutation(ws.slug, (id: string) =>
    api.del(wsPath(ws.slug, `/customer-requests/${id}`)),
  );
  const [customer, setCustomer] = useState('');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  if (ws.isGuest) return null;

  const submit = (close: () => void) => async (e: FormEvent) => {
    e.preventDefault();
    const typed = customer.trim();
    if (!typed) return;
    const known = ws.customers.find((c) => c.name.toLowerCase() === typed.toLowerCase());
    const customerId = known?.id ?? (await create.mutateAsync(typed)).id;
    add.mutate(
      { customerId, body, contact: contact.trim() || undefined },
      {
        onSuccess: () => {
          setCustomer('');
          setBody('');
          setContact('');
          close();
          onChange();
        },
      },
    );
  };

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center gap-3">
        <div className="section-label flex-1">Customer requests</div>
        <Popover
          width={360}
          trigger={
            <button type="button" className="btn btn-ghost btn-sm">
              <Plus size={12} /> Add request
            </button>
          }
        >
          {(close) => (
            <form className="p-3" onSubmit={submit(close)}>
              <input
                className="input mb-2"
                list="ordo-customers"
                placeholder="Customer (new names are created)"
                required
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                aria-label="Customer"
              />
              <datalist id="ordo-customers">
                {ws.customers.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
              <textarea
                className="input mb-2 min-h-20 resize-y py-2"
                placeholder="What they asked for, in their words"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                aria-label="Request"
              />
              <input
                className="input mb-3"
                placeholder="Contact (optional), e.g. Ada <ada@acme.com>"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                aria-label="Contact"
              />
              <button className="btn btn-primary btn-sm w-full" disabled={add.isPending}>
                Add request
              </button>
            </form>
          )}
        </Popover>
      </div>
      {issue.customerRequests.map((r) => {
        const c = ws.customers.find((x) => x.id === r.customerId);
        return (
          <div key={r.id} className="group border-b border-border-soft/60 px-2 py-2">
            <div className="flex items-center gap-2">
              <Building2 size={13} className="flex-none text-index" />
              <Link
                to="/$slug/customer/$customerId"
                params={{ slug: ws.slug, customerId: r.customerId }}
                className="text-[13.5px] hover:text-highlight"
              >
                {c?.name ?? 'Customer'}
              </Link>
              <span className="ml-auto font-mono text-[11px] text-index">
                {[r.contact, r.source === 'manual' ? null : r.source, relativeTime(r.createdAt)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center text-index opacity-0 group-hover:opacity-100 hover:text-text"
                onClick={() => remove.mutate(r.id, { onSuccess: onChange })}
                aria-label="Remove request"
              >
                <X size={13} />
              </button>
            </div>
            {r.body && (
              <blockquote className="mt-1 ml-5 border-l border-border pl-3 text-[13px] whitespace-pre-wrap text-muted">
                {r.body}
              </blockquote>
            )}
          </div>
        );
      })}
      {issue.customerRequests.length === 0 && (
        <p className="px-2 font-mono text-[12px] text-index">// who asked for this?</p>
      )}
    </section>
  );
}

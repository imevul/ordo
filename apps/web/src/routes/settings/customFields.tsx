import {
  CUSTOM_FIELD_TYPES,
  type CustomField,
  type CustomFieldOption,
  type CustomFieldType,
  LABEL_COLORS,
  sortOrderBetween,
} from '@ordo/shared';
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { fieldTypeLabel } from '../../i18n/labels.ts';
import { useWorkspace, type WorkspaceData } from '../../lib/workspace.tsx';
import { ColorPicker } from './labels.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const hasOptions = (type: CustomFieldType) => type === 'select' || type === 'multi_select';

/** Workspace fields are the workspace admins'; a team's fields also its team admins'. */
const canManage = (ws: WorkspaceData, teamId: string | null) =>
  teamId ? ws.canAdminTeam(teamId) : ws.isAdmin;

const iconBtn =
  'flex h-7 w-7 flex-none items-center justify-center text-index hover:text-text disabled:opacity-30 disabled:hover:text-index';

/** A text box that saves when left or on Enter, and follows the saved value. */
function CommitInput({
  value,
  onCommit,
  className,
  placeholder,
  label,
  disabled,
  allowEmpty,
}: {
  value: string;
  onCommit: (v: string) => void;
  className: string;
  placeholder?: string;
  label: string;
  disabled?: boolean;
  allowEmpty?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className={className}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const v = draft.trim();
        if (v === value.trim()) return;
        if (!v && !allowEmpty) setDraft(value);
        else onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const inlineInput =
  'h-8 min-w-0 flex-1 bg-transparent outline-none focus:shadow-[inset_0_-1px_0_var(--color-primary)] disabled:text-muted';

function OptionsEditor({
  field,
  editable,
  onSave,
}: {
  field: CustomField;
  editable: boolean;
  onSave: (options: CustomFieldOption[]) => void;
}) {
  const [name, setName] = useState('');
  // Edits apply here at once, so a second edit before the workspace reloads builds on the first.
  const [options, setOptions] = useState(field.options);
  useEffect(() => setOptions(field.options), [field.options]);
  const save = (next: CustomFieldOption[]) => {
    setOptions(next);
    onSave(next);
  };
  const replace = (i: number, o: CustomFieldOption) =>
    save(options.map((x, j) => (j === i ? o : x)));
  const move = (i: number, by: number) => {
    const next = [...options];
    const [o] = next.splice(i, 1);
    next.splice(i + by, 0, o!);
    save(next);
  };
  return (
    <div className="mb-3">
      <div className="mb-1 text-[12px] text-muted">{t('customFields.settings.options')}</div>
      {options.length === 0 && (
        <p className="mb-2 text-[12.5px] text-index">{t('customFields.settings.noOptions')}</p>
      )}
      {options.map((o, i) => (
        <div
          key={o.id || `new:${o.name}`}
          className="flex h-9 items-center gap-2 border-b border-border-soft/60"
        >
          <ColorPicker
            value={o.color}
            disabled={!editable}
            label={t('customFields.settings.changeColor', { name: o.name })}
            onChange={(color) => replace(i, { ...o, color })}
          />
          <CommitInput
            className={`${inlineInput} text-[13px]`}
            value={o.name}
            label={t('customFields.settings.optionName')}
            disabled={!editable}
            onCommit={(n) => replace(i, { ...o, name: n })}
          />
          {editable && (
            <>
              <button
                type="button"
                className={iconBtn}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label={t('customFields.settings.moveUp', { name: o.name })}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className={iconBtn}
                disabled={i === options.length - 1}
                onClick={() => move(i, 1)}
                aria-label={t('customFields.settings.moveDown', { name: o.name })}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className={`${iconBtn} hover:text-error`}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: t('customFields.settings.removeOptionTitle', { name: o.name }),
                      body: t('customFields.settings.removeOptionBody'),
                      danger: true,
                    })
                  )
                    save(options.filter((x) => x !== o));
                }}
                aria-label={t('customFields.settings.removeOption', { name: o.name })}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      ))}
      {editable && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            // No id: the server gives the new option one. The color is only a placeholder.
            save([
              ...options,
              { id: '', name: n, color: LABEL_COLORS[options.length % LABEL_COLORS.length]! },
            ]);
            setName('');
          }}
        >
          <input
            className="input min-w-0 flex-1"
            placeholder={t('customFields.settings.newOption')}
            aria-label={t('customFields.settings.newOption')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost btn-sm" disabled={!name.trim()}>
            <Plus size={13} /> {t('customFields.settings.addOption')}
          </button>
        </form>
      )}
    </div>
  );
}

function FieldRow({
  field,
  open,
  onToggle,
  prev,
  next,
}: {
  field: CustomField;
  open: boolean;
  onToggle: () => void;
  /** The neighbours within the same scope, for moving the field up and down. */
  prev?: CustomField;
  next?: CustomField;
}) {
  const ws = useWorkspace();
  const editable = canManage(ws, field.teamId);
  const team = field.teamId ? ws.teamById.get(field.teamId) : null;
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/custom-fields/${field.id}`), body),
  );
  const remove = useWsMutation(ws.slug, () =>
    api.del(wsPath(ws.slug, `/custom-fields/${field.id}`)),
  );
  const saveOptions = (options: CustomFieldOption[]) =>
    save.mutate({
      // A new option has no id yet; the server makes one.
      options: options.map(({ id, name, color }) => ({ id: id || undefined, name, color })),
    });
  return (
    <div className="border-b border-border-soft">
      <div className="flex h-11 items-center gap-2">
        <button
          type="button"
          className={iconBtn}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={t('customFields.settings.edit', { name: field.name })}
        >
          <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        <CommitInput
          className={inlineInput}
          value={field.name}
          label={t('customFields.settings.name')}
          disabled={!editable}
          onCommit={(name) => save.mutate({ name })}
        />
        <span className="tag hidden sm:inline-flex">{fieldTypeLabel(field.type)}</span>
        <span className="tag font-mono">
          {team ? team.key : t('customFields.settings.workspaceTag')}
        </span>
        {editable && (
          <>
            <button
              type="button"
              className={iconBtn}
              disabled={!prev}
              onClick={() =>
                prev &&
                save.mutate({
                  position: sortOrderBetween(prevOf(ws, field, prev)?.position, prev.position),
                })
              }
              aria-label={t('customFields.settings.moveUp', { name: field.name })}
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              className={iconBtn}
              disabled={!next}
              onClick={() =>
                next &&
                save.mutate({
                  position: sortOrderBetween(next.position, nextOf(ws, field, next)?.position),
                })
              }
              aria-label={t('customFields.settings.moveDown', { name: field.name })}
            >
              <ArrowDown size={13} />
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t('customFields.settings.deleteTitle', { name: field.name }),
                    body: t('customFields.settings.deleteBody'),
                    danger: true,
                  })
                )
                  remove.mutate(undefined);
              }}
              aria-label={t('customFields.settings.deleteField', { name: field.name })}
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="pb-4 pl-9">
          <div className="mb-3 text-[12px] text-muted sm:hidden">{fieldTypeLabel(field.type)}</div>
          <FormRow label={t('customFields.settings.descriptionLabel')}>
            <CommitInput
              className="input w-full"
              value={field.description ?? ''}
              placeholder={t('customFields.settings.descriptionPlaceholder')}
              label={t('customFields.settings.descriptionLabel')}
              disabled={!editable}
              allowEmpty
              onCommit={(description) => save.mutate({ description: description || null })}
            />
          </FormRow>
          {hasOptions(field.type) && (
            <OptionsEditor field={field} editable={editable} onSave={saveOptions} />
          )}
          <p className="text-[11.5px] text-index">{t('customFields.settings.fixedHint')}</p>
        </div>
      )}
    </div>
  );
}

/** Every field: the workspace's, then each team's together, in their order. */
const byScope = (ws: WorkspaceData) => {
  const teamName = (f: CustomField) => (f.teamId ? (ws.teamById.get(f.teamId)?.name ?? '') : '');
  return [...ws.customFields].sort(
    (a, b) =>
      Number(!!a.teamId) - Number(!!b.teamId) ||
      teamName(a).localeCompare(teamName(b)) ||
      (a.teamId ?? '').localeCompare(b.teamId ?? '') ||
      a.position - b.position ||
      a.name.localeCompare(b.name),
  );
};

/** Fields of the same scope (workspace, or one team), in order. */
const siblings = (ws: WorkspaceData, field: CustomField) =>
  byScope(ws).filter((f) => f.teamId === field.teamId);

/** The field before `prev` (skipping `field`), to place `field` between the two. */
function prevOf(ws: WorkspaceData, field: CustomField, prev: CustomField) {
  const list = siblings(ws, field).filter((f) => f.id !== field.id);
  return list[list.findIndex((f) => f.id === prev.id) - 1];
}

function nextOf(ws: WorkspaceData, field: CustomField, next: CustomField) {
  const list = siblings(ws, field).filter((f) => f.id !== field.id);
  return list[list.findIndex((f) => f.id === next.id) + 1];
}

function CreateFieldForm({ onCreated }: { onCreated: (field: CustomField) => void }) {
  const ws = useWorkspace();
  const teams = ws.teams.filter((team) => ws.canAdminTeam(team.id));
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('select');
  const [teamId, setTeamId] = useState(ws.isAdmin ? '' : (teams[0]?.id ?? ''));
  const [description, setDescription] = useState('');
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<CustomField>(wsPath(ws.slug, '/custom-fields'), body),
    { success: t('customFields.settings.created') },
  );
  if (!ws.isAdmin && teams.length === 0) return null;
  return (
    <form
      className="mb-5 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        create.mutate(
          { name, type, teamId: teamId || null, description: description.trim() || null },
          {
            onSuccess: (field) => {
              setName('');
              setDescription('');
              onCreated(field);
            },
          },
        );
      }}
    >
      <input
        className="input min-w-0 flex-1 basis-48"
        placeholder={t('customFields.settings.newField')}
        aria-label={t('customFields.settings.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className="input w-36"
        aria-label={t('customFields.settings.type')}
        value={type}
        onChange={(e) => setType(e.target.value as CustomFieldType)}
      >
        {CUSTOM_FIELD_TYPES.map((ty) => (
          <option key={ty} value={ty}>
            {fieldTypeLabel(ty)}
          </option>
        ))}
      </select>
      <select
        className="input w-36"
        aria-label={t('customFields.settings.scope')}
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
      >
        {ws.isAdmin && <option value="">{t('customFields.settings.workspace')}</option>}
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn-primary" disabled={create.isPending}>
        {t('common.add')}
      </button>
      <input
        className="input w-full"
        placeholder={t('customFields.settings.descriptionPlaceholder')}
        aria-label={t('customFields.settings.descriptionLabel')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
    </form>
  );
}

export function CustomFieldsSection() {
  const ws = useWorkspace();
  const [openId, setOpenId] = useState<string | null>(null);
  const fields = byScope(ws);
  return (
    <SettingsCard
      title={t('customFields.settings.title')}
      description={t('customFields.settings.description')}
    >
      <CreateFieldForm
        // Fields with options open right away: they need some before they're any use.
        onCreated={(f) => hasOptions(f.type) && setOpenId(f.id)}
      />
      {fields.map((f, i) => (
        <FieldRow
          key={f.id}
          field={f}
          open={openId === f.id}
          onToggle={() => setOpenId(openId === f.id ? null : f.id)}
          prev={fields[i - 1]?.teamId === f.teamId ? fields[i - 1] : undefined}
          next={fields[i + 1]?.teamId === f.teamId ? fields[i + 1] : undefined}
        />
      ))}
      {fields.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('customFields.settings.empty')}</p>
      )}
    </SettingsCard>
  );
}

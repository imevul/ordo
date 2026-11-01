import type { PublicRequestForm, RequestFormCaptchaProvider, RequestFormField } from '@ordo/shared';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, api, postForm } from '../api/client.ts';
import { OrdoMark } from '../components/icons.tsx';
import { Spinner } from '../components/PageHeader.tsx';
import { getLocale, t } from '../i18n/index.ts';
import { ErrorLine, message } from './auth/ui.tsx';

interface CaptchaApi {
  render: (
    el: HTMLElement,
    opts: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void },
  ) => string;
  reset: (id: string) => void;
}

// Both providers load the same way and have the same render/reset calls.
const CAPTCHA_SCRIPTS: Record<RequestFormCaptchaProvider, { src: string; global: string }> = {
  turnstile: {
    src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    global: 'turnstile',
  },
  hcaptcha: { src: 'https://js.hcaptcha.com/1/api.js?render=explicit', global: 'hcaptcha' },
};

function loadCaptcha(provider: RequestFormCaptchaProvider): Promise<CaptchaApi> {
  const { src, global } = CAPTCHA_SCRIPTS[provider];
  const ready = () => (window as unknown as Record<string, CaptchaApi | undefined>)[global];
  return new Promise((resolve, reject) => {
    const wait = () => {
      const started = Date.now();
      const tick = () => {
        const loaded = ready();
        if (loaded) resolve(loaded);
        else if (Date.now() - started > 15_000) reject(new Error('CAPTCHA timed out'));
        else setTimeout(tick, 100);
      };
      tick();
    };
    if (document.querySelector(`script[src="${src}"]`)) return wait();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = wait;
    script.onerror = () => reject(new Error('CAPTCHA failed to load'));
    document.head.append(script);
  });
}

function Captcha({
  provider,
  siteKey,
  onToken,
  resetKey,
}: {
  provider: RequestFormCaptchaProvider;
  siteKey: string;
  onToken: (token: string | null) => void;
  /** Changes when a token has been used up, which asks for a new one. */
  resetKey: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: CaptchaApi; id: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    loadCaptcha(provider)
      .then((captcha) => {
        if (gone || !el.current || widget.current) return;
        widget.current = {
          api: captcha,
          id: captcha.render(el.current, {
            sitekey: siteKey,
            callback: onToken,
            'expired-callback': () => onToken(null),
          }),
        };
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
    };
  }, [provider, siteKey, onToken]);

  useEffect(() => {
    if (resetKey && widget.current) widget.current.api.reset(widget.current.id);
  }, [resetKey]);

  return (
    <div className="mb-4">
      <div ref={el} />
      {failed && (
        <p className="text-[12.5px] text-error">{t('requestForm.public.captchaUnavailable')}</p>
      )}
    </div>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="hud-ground flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <OrdoMark className="mb-8" />
        <div className="brackets">
          <div className="panel panel-raised p-7">
            <div className="kicker">
              <span className="text-muted">// </span>
              {t('requestForm.public.kicker')}
            </div>
            <h1 className="mt-2 text-[28px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({
  text,
  required,
  children,
}: {
  text: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
        {text}
        {required && <span className="text-primary"> *</span>}
      </span>
      {children}
    </label>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: RequestFormField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  if (field.type === 'checkbox')
    return (
      <label className="mb-4 flex items-start gap-2 text-[13.5px]">
        <input
          type="checkbox"
          className="mt-1 accent-primary"
          required={field.required}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {field.label}
          {field.required && <span className="text-primary"> *</span>}
        </span>
      </label>
    );
  const text = typeof value === 'string' ? value : '';
  return (
    <Label text={field.label} required={field.required}>
      {field.type === 'textarea' ? (
        <textarea
          className="input"
          rows={4}
          maxLength={5000}
          required={field.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === 'select' ? (
        <select
          className="input"
          required={field.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t('requestForm.public.choose')}</option>
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          maxLength={5000}
          required={field.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Label>
  );
}

const EMPTY = { name: '', email: '', title: '', description: '', website: '' };

/** /request-form/:token, for people without an account. It works inside an iframe too. */
export function RequestFormPage() {
  const { token } = useParams({ from: '/request-form/$token' });
  const [form, setForm] = useState<PublicRequestForm | null>(null);
  const [missing, setMissing] = useState(false);
  const [v, setV] = useState(EMPTY);
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api
      .get<PublicRequestForm>(`/forms/${encodeURIComponent(token)}`)
      .then(setForm)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(message(err));
      });
  }, [token]);

  if (missing)
    return (
      <Shell title={t('requestForm.public.notFound')}>
        <p className="text-[13.5px] text-muted">{t('requestForm.public.notFoundBody')}</p>
      </Shell>
    );
  if (!form)
    return error ? (
      <Shell title={t('requestForm.public.defaultTitle')}>
        <ErrorLine error={error} />
      </Shell>
    ) : (
      <Spinner />
    );
  const title = form.title || t('requestForm.public.defaultTitle');
  const limits = form.attachments;

  if (sent)
    return (
      <Shell title={t('requestForm.public.sent')}>
        <p className="mb-5 text-[13.5px] text-muted">{t('requestForm.public.sentBody')}</p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setSent(false);
            setV(EMPTY);
            setAnswers({});
            setFiles([]);
          }}
        >
          {t('requestForm.public.another')}
        </button>
      </Shell>
    );

  const pickFiles = (picked: File[]) => {
    if (!limits) return;
    setError(null);
    if (picked.length > limits.maxFiles)
      return setError(t('requestForm.public.tooManyFiles', { maxFiles: limits.maxFiles }));
    const big = picked.find((f) => f.size > limits.maxFileMb * 1024 * 1024);
    if (big)
      return setError(
        t('requestForm.public.fileTooLarge', { name: big.name, maxFileMb: limits.maxFileMb }),
      );
    setFiles(picked);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.captcha && !captchaToken) return setError(t('requestForm.public.captchaNeeded'));
    const body = new FormData();
    body.append(
      'payload',
      JSON.stringify({
        ...v,
        answers,
        locale: getLocale(),
        ...(captchaToken && { captchaToken }),
      }),
    );
    for (const file of files) body.append('file', file, file.name);
    setBusy(true);
    try {
      await postForm(`/forms/${encodeURIComponent(token)}`, body);
      setSent(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
      // A token works once, whichever way this went.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
    }
  };

  return (
    <Shell title={title}>
      {form.intro && (
        <p className="mb-5 text-[13.5px] whitespace-pre-wrap text-muted">{form.intro}</p>
      )}
      <ErrorLine error={error} />
      <form onSubmit={submit}>
        <Label text={t('requestForm.public.name')} required>
          <input
            className="input"
            required
            maxLength={200}
            autoComplete="name"
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
          />
        </Label>
        <Label text={t('requestForm.public.email')} required>
          <input
            className="input"
            type="email"
            required
            maxLength={320}
            autoComplete="email"
            value={v.email}
            onChange={(e) => setV({ ...v, email: e.target.value })}
          />
        </Label>
        <Label text={t('requestForm.public.subject')} required>
          <input
            className="input"
            required
            maxLength={500}
            value={v.title}
            onChange={(e) => setV({ ...v, title: e.target.value })}
          />
        </Label>
        <Label text={t('requestForm.public.description')}>
          <textarea
            className="input"
            rows={6}
            maxLength={50_000}
            value={v.description}
            onChange={(e) => setV({ ...v, description: e.target.value })}
          />
        </Label>
        {form.fields.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            value={answers[field.id]}
            onChange={(value) => setAnswers({ ...answers, [field.id]: value })}
          />
        ))}
        {limits && (
          <Label text={t('requestForm.public.files')}>
            <input
              className="input"
              type="file"
              multiple
              onChange={(e) => pickFiles([...(e.target.files ?? [])])}
            />
            <span className="mt-1 block text-[11.5px] text-index">
              {t('requestForm.public.filesHint', limits)}
            </span>
          </Label>
        )}
        {/* The honeypot: out of sight and out of the tab order, so only a bot fills it in. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            {t('requestForm.public.website')}
            <input
              tabIndex={-1}
              autoComplete="off"
              value={v.website}
              onChange={(e) => setV({ ...v, website: e.target.value })}
            />
          </label>
        </div>
        {form.captcha && (
          <Captcha
            provider={form.captcha.provider}
            siteKey={form.captcha.siteKey}
            onToken={setCaptchaToken}
            resetKey={captchaReset}
          />
        )}
        <button className="btn btn-primary w-full" disabled={busy}>
          {t('requestForm.public.submit')} <span className="arrow">→</span>
        </button>
      </form>
    </Shell>
  );
}

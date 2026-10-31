import { Copy } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { t } from '../../../i18n/index.ts';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));
export const here = () => window.location.pathname;

/** `?error=` left by an OIDC redirect (link or test mode) is shown once, then dropped. */
export function useRedirectError() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    if (!error) return;
    toast.error(error);
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url);
  }, []);
}

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success(t('common.copied'));
};

/** A value to hand to the identity provider, with a copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-text">{value}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(value)}>
          <Copy size={12} /> {t('common.copy')}
        </button>
      </div>
    </div>
  );
}

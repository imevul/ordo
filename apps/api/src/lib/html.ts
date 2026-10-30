const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML (and XML) element content and quoted attribute values. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

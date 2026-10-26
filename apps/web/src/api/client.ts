export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.error);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Multipart upload (the one non-JSON request). */
export async function upload<T>(path: string, file: Blob, filename: string): Promise<T> {
  const form = new FormData();
  form.append('file', file, filename);
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.error);
  return data as T;
}

/** Shorthand for workspace-scoped paths. */
export const wsPath = (slug: string, path: string) => `/w/${encodeURIComponent(slug)}${path}`;

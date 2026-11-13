import { lang } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    // X-Lang: o servidor responde as mensagens de erro no idioma da pessoa.
    headers: { 'X-Lang': lang, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/login') && !url.startsWith('/setup') && !url.startsWith('/me')) {
      window.location.href = '/login';
    }
    throw new ApiError(res.status, data.error || res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  // An image pasted or attached to a text; answers the address to put in the markdown.
  upload: async (file: Blob) => {
    const res = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'X-Lang': lang }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data as { url: string };
  }
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }

  /** Message for a specific form field, if the API reported one. */
  field(path: string): string | undefined {
    return this.details?.find((d) => d.path === path || d.path.endsWith(`.${path}`))?.message;
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
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

/** GET a plain-text response (file contents). */
async function text(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  const body = await res.text();
  if (!res.ok) {
    let data: any = {};
    try {
      data = JSON.parse(body);
    } catch {
      data = { message: body };
    }
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`, data?.details);
  }
  return body;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  text,
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export interface Paged<T> {
  data: T[];
  meta: { page: number; perPage: number; total: number; pages: number };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

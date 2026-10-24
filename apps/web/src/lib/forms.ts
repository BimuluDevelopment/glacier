import { useState } from 'react';
import { ApiError } from './api';

/** Tiny form-state helper: values, per-field errors from the API, and a submit wrapper. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof T>(key: K, value: T[K]) => setValues((v) => ({ ...v, [key]: value }));

  const bind = (key: keyof T & string) => ({
    value: (values[key] ?? '') as string,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as T[typeof key]),
    invalid: Boolean(fieldError(key)),
  });

  const fieldError = (key: string) => (error instanceof ApiError ? error.field(key) : undefined);

  const submit = (fn: (values: T) => Promise<unknown>) => async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await fn(values);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSubmitting(false);
    }
  };

  return { values, setValues, set, bind, error, setError, fieldError, submitting, submit };
}

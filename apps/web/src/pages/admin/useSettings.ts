import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Settings, SettingsSection } from '@glacier/shared';
import { api } from '../../lib/api';

export function useAdminSettings() {
  return useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<Settings>('/admin/settings') });
}

/** Save one settings section and refresh everything that depends on it (incl. the live theme). */
export function useSaveSection<K extends SettingsSection>(section: K) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: Partial<Settings[K]>) => api.put<Settings[K]>(`/admin/settings/${section}`, value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void qc.invalidateQueries({ queryKey: ['branding'] });
    },
  });
}

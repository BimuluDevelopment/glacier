import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CurrentUser {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  rootAdmin: boolean;
  language: string;
  totpEnabled: boolean;
  createdAt: string;
}

interface AuthContextValue {
  user: CurrentUser | null;
  /** The admin requires 2FA and this account has neither an authenticator app nor a passkey. */
  mustSetupTwoFactor: boolean;
  loading: boolean;
  setUser: (user: CurrentUser | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: CurrentUser | null; mustSetupTwoFactor?: boolean }>('/auth/me'),
    staleTime: 5 * 60_000,
  });

  const setUser = (user: CurrentUser | null) => {
    qc.setQueryData(['me'], { user, mustSetupTwoFactor: false });
    // Sign-in responses don't carry the 2FA requirement; ask the server.
    if (user) void qc.invalidateQueries({ queryKey: ['me'] });
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user: data?.user ?? null, mustSetupTwoFactor: Boolean(data?.mustSetupTwoFactor), loading: isLoading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

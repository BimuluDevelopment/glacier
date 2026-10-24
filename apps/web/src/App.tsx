import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider';
import { useTheme } from './theme/ThemeProvider';
import { AdminShell, AppShell } from './components/layout';
import { PageLoader } from './components/ui';
import { LoginPage, MaintenancePage, RegisterPage, SetupPage } from './pages/auth';
import { DashboardPage } from './pages/dashboard';
import { ServerLayout } from './pages/server/layout';
import { ConsoleTab } from './pages/server/console';
import { FilesTab } from './pages/server/files';
import { FileEditorTab } from './pages/server/file-editor';
import { BackupsTab } from './pages/server/backups';
import { SchedulesTab } from './pages/server/schedules';
import { UsersTab } from './pages/server/users';
import { DatabasesTab } from './pages/server/databases';
import { PluginsTab } from './pages/server/plugins';
import { PlayersTab } from './pages/server/players';
import { ProxyTab } from './pages/server/proxy';
import { ActivityTab, NetworkTab, SettingsTab, StartupTab } from './pages/server/manage';
import { DatabaseHostsPage } from './pages/admin/database-hosts';
import { LandingBuilderPage } from './pages/admin/landing';
import { NavigationPage } from './pages/admin/navigation';
import { PageEditorPage, PagesListPage } from './pages/admin/pages';
import { EmailPage } from './pages/admin/email';
import { LocalizationPage } from './pages/admin/localization';
import { SecurityPage } from './pages/admin/security';
import { WebhooksPage } from './pages/admin/webhooks';
import { AnnouncementsPage } from './pages/admin/announcements';
import { TemplatesPage } from './pages/admin/templates';
import { CustomPage, ForgotPasswordPage, ResetPasswordPage } from './pages/public';
import { LandingPage } from './features/landing/Landing';
import { AccountPage } from './pages/account';
import { ActivityPage, OverviewPage } from './pages/admin/overview';
import { AppearancePage } from './pages/admin/appearance';
import { SettingsPage } from './pages/admin/settings';
import { UsersPage } from './pages/admin/users';
import { LocationsPage } from './pages/admin/locations';
import { NodeDetailPage, NodesPage } from './pages/admin/nodes';
import { EggDetailPage, EggsPage } from './pages/admin/eggs';
import { CreateServerPage, ServerDetailPage, ServersPage } from './pages/admin/servers';

function RequireUser({ children }: { children: ReactNode }) {
  const { user, mustSetupTwoFactor } = useAuth();
  const { branding } = useTheme();
  const location = useLocation();
  if (!user) {
    // Visitors see the landing page at / when it's enabled; everything else needs a sign-in.
    if (location.pathname === '/' && branding.features.landingPage) return <LandingPage />;
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (branding.general.maintenanceMode && !user.rootAdmin) return <MaintenancePage />;
  // The API refuses everything else until 2FA is on, so send them where they can turn it on.
  if (mustSetupTwoFactor && location.pathname !== '/account') return <Navigate to="/account#security" replace />;
  return children;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.rootAdmin ? children : <Navigate to="/" replace />;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <Navigate to="/" replace /> : children;
}

export function App() {
  const { loading: authLoading } = useAuth();
  const { loading: brandingLoading, branding } = useTheme();

  if (authLoading || brandingLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <PageLoader />
      </div>
    );
  }

  if (branding.needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
      <Route path="/forgot-password" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/p/:slug" element={<CustomPage />} />
      {branding.features.landingPage && <Route path="/welcome" element={<LandingPage />} />}
      {branding.features.registration && <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />}
      <Route element={<RequireUser><AppShell /></RequireUser>}>
        <Route index element={<DashboardPage />} />
        <Route path="server/:id" element={<ServerLayout />}>
          <Route index element={<ConsoleTab />} />
          <Route path="files" element={<FilesTab />} />
          <Route path="files/edit" element={<FileEditorTab />} />
          <Route path="databases" element={<DatabasesTab />} />
          <Route path="schedules" element={<SchedulesTab />} />
          <Route path="users" element={<UsersTab />} />
          <Route path="backups" element={<BackupsTab />} />
          <Route path="network" element={<NetworkTab />} />
          <Route path="startup" element={<StartupTab />} />
          <Route path="settings" element={<SettingsTab />} />
          <Route path="activity" element={<ActivityTab />} />
          <Route path="plugins" element={<PluginsTab />} />
          <Route path="players" element={<PlayersTab />} />
          <Route path="proxy" element={<ProxyTab />} />
        </Route>
        <Route path="account" element={<AccountPage />} />
        <Route path="admin" element={<RequireAdmin><AdminShell /></RequireAdmin>}>
          <Route index element={<OverviewPage />} />
          <Route path="appearance" element={<AppearancePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="servers/new" element={<CreateServerPage />} />
          <Route path="templates" element={<TemplatesPage />} />
          <Route path="servers/:id" element={<ServerDetailPage />} />
          <Route path="nodes" element={<NodesPage />} />
          <Route path="nodes/:id" element={<NodeDetailPage />} />
          <Route path="locations" element={<LocationsPage />} />
          <Route path="database-hosts" element={<DatabaseHostsPage />} />
          <Route path="landing" element={<LandingBuilderPage />} />
          <Route path="navigation" element={<NavigationPage />} />
          <Route path="pages" element={<PagesListPage />} />
          <Route path="pages/:id" element={<PageEditorPage />} />
          <Route path="email" element={<EmailPage />} />
          <Route path="localization" element={<LocalizationPage />} />
          <Route path="security" element={<SecurityPage />} />
          <Route path="webhooks" element={<WebhooksPage />} />
          <Route path="announcements" element={<AnnouncementsPage />} />
          <Route path="eggs" element={<EggsPage />} />
          <Route path="eggs/:id" element={<EggDetailPage />} />
          <Route path="activity" element={<ActivityPage />} />
        </Route>
      </Route>
      <Route path="setup" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

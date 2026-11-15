import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { RealtimeProvider } from './context/RealtimeContext';
import { Layout } from './components/Layout';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { TeamsPage } from './pages/TeamsPage';
import { TeamDetailPage } from './pages/TeamDetailPage';
import { RaceLabPage } from './pages/RaceLabPage';
import { AuditExplorerPage } from './pages/AuditExplorerPage';
import { ProfilePage } from './pages/ProfilePage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <RealtimeProvider>
            <BrowserRouter>
              <Layout>
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/login" element={<AuthPage defaultMode="login" />} />
                  <Route path="/register" element={<AuthPage defaultMode="register" />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/teams" element={<TeamsPage />} />
                  <Route path="/teams/:id" element={<TeamDetailPage />} />
                  <Route path="/racelab" element={<RaceLabPage />} />
                  <Route path="/audit" element={<AuditExplorerPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </BrowserRouter>
          </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

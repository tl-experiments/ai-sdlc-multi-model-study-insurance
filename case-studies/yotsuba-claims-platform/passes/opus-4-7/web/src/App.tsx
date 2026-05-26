import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { LoginPage } from './pages/Login';
import { ClaimQueuePage } from './pages/ClaimQueue';
import { ClaimDetailPage } from './pages/ClaimDetail';
import { ReserveApprovalsPage } from './pages/ReserveApprovals';
import { AuditLogPage } from './pages/AuditLog';

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-500">Loading…</div>
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}

function RedirectIfAuthed({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-500">Loading…</div>
      </div>
    );
  }
  if (user !== null) {
    return <Navigate to="/claims" replace />;
  }
  return children;
}

function DocumentTitleEffect(): null {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    let suffix = 'Yotsuba Claims';
    if (path.startsWith('/login')) suffix = 'Sign in · Yotsuba Claims';
    else if (path.startsWith('/claims/')) suffix = 'Claim Detail · Yotsuba Claims';
    else if (path.startsWith('/claims')) suffix = 'Claim Queue · Yotsuba Claims';
    else if (path.startsWith('/reserves')) suffix = 'Reserve Approvals · Yotsuba Claims';
    else if (path.startsWith('/audit')) suffix = 'Audit Log · Yotsuba Claims';
    document.title = suffix;
  }, [location.pathname]);
  return null;
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DocumentTitleEffect />
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <LoginPage />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/claims"
            element={
              <RequireAuth>
                <ClaimQueuePage />
              </RequireAuth>
            }
          />
          <Route
            path="/claims/:id"
            element={
              <RequireAuth>
                <ClaimDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/reserves"
            element={
              <RequireAuth>
                <ReserveApprovalsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireAuth>
                <AuditLogPage />
              </RequireAuth>
            }
          />
          <Route path="/" element={<Navigate to="/claims" replace />} />
          <Route path="*" element={<Navigate to="/claims" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
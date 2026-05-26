/**
 * App.tsx
 * Main application component for the Adjuster Workbench.
 * Provides routing, authentication context, and layout for the claims processing platform.
 */

import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import Login from './pages/Login';
import ClaimQueue from './pages/ClaimQueue';
import ClaimDetail from './pages/ClaimDetail';
import ReserveApprovals from './pages/ReserveApprovals';
import AuditLog from './pages/AuditLog';

/**
 * ProtectedRoute component — guards routes that require authentication.
 * Redirects unauthenticated users to the login page.
 */
interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRole,
}) => {
  const { currentUser: user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="text-center">
          <p className="text-gray-600 mb-4">Loading…</p>
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="text-center">
          <p className="text-red-600 font-medium">Access Denied</p>
          <p className="text-gray-600 text-sm mt-2">
            You do not have permission to access this page.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

/**
 * AppRoutes component — defines all application routes.
 * Separated from App to allow useAuth hook usage.
 */
const AppRoutes: React.FC = () => {
  const { currentUser: user } = useAuth();

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<Login />} />

      {/* Protected routes */}
      <Route
        path="/claims"
        element={
          <ProtectedRoute>
            <ClaimQueue />
          </ProtectedRoute>
        }
      />

      <Route
        path="/claims/:id"
        element={
          <ProtectedRoute>
            <ClaimDetail />
          </ProtectedRoute>
        }
      />

      <Route
        path="/reserves"
        element={
          <ProtectedRoute>
            <ReserveApprovals />
          </ProtectedRoute>
        }
      />

      <Route
        path="/audit"
        element={
          <ProtectedRoute requiredRole="auditor">
            <AuditLog />
          </ProtectedRoute>
        }
      />

      {/* Default redirect */}
      <Route
        path="/"
        element={
          user ? <Navigate to="/claims" replace /> : <Navigate to="/login" replace />
        }
      />

      {/* 404 fallback */}
      <Route
        path="*"
        element={
          <div className="flex items-center justify-center min-h-screen bg-gray-100">
            <div className="text-center">
              <p className="text-4xl font-bold text-gray-900 mb-2">404</p>
              <p className="text-gray-600 mb-4">Page not found</p>
              <a
                href="/claims"
                className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                ← Back to Claims
              </a>
            </div>
          </div>
        }
      />
    </Routes>
  );
};

/**
 * App component — root application component.
 * Provides authentication context and routing.
 */
const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </Router>
  );
};

export default App;
import React, { useState, useEffect } from 'react';
import ClaimQueue from './pages/ClaimQueue';
import ClaimDetail from './pages/ClaimDetail';
import ReserveApprovals from './pages/ReserveApprovals';
import AuditLog from './pages/AuditLog';

interface RouteState {
  view: 'claims' | 'claim-detail' | 'reserves' | 'audit';
  claimId: string | null;
}

const parseHash = (): RouteState => {
  const hash = window.location.hash || '#/';
  
  if (hash.startsWith('#/claims/')) {
    const claimId = hash.replace('#/claims/', '');
    return { view: 'claim-detail', claimId };
  }
  if (hash === '#/reserves') {
    return { view: 'reserves', claimId: null };
  }
  if (hash === '#/audit') {
    return { view: 'audit', claimId: null };
  }
  return { view: 'claims', claimId: null };
};

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => parseHash());

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseHash());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const renderPage = () => {
    switch (route.view) {
      case 'claim-detail':
        return <ClaimDetail claimId={route.claimId || ''} />;
      case 'reserves':
        return <ReserveApprovals />;
      case 'audit':
        return <AuditLog />;
      case 'claims':
      default:
        return <ClaimQueue />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 selection:bg-indigo-500 selection:text-white">
      {renderPage()}
    </div>
  );
}
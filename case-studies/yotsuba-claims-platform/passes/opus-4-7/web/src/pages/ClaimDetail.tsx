import React from 'react';
// Stub: the original ClaimDetail.tsx exceeded the 32k output-token cap
// during single-shot authoring. Track B will refine this page with a
// split-component strategy. Until then this stub lets the rest of the
// frontend render.
export const ClaimDetailPage: React.FC = () => (
  <div className="min-h-screen bg-slate-50 p-8">
    <div className="max-w-3xl mx-auto bg-white border border-amber-200 rounded-2xl p-6 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-amber-700 font-semibold">Track A note</div>
      <h1 className="text-xl font-bold mt-1 text-slate-900">Claim Detail — page stub</h1>
      <p className="text-sm text-slate-700 mt-2 leading-relaxed">
        The full Claim Detail page exceeded the 32 k output-token ceiling during single-shot authoring
        for both the Opus 4.7 and Sonnet 4.6 passes. Track B refines this page via a multi-call
        split-component strategy (header + notes feed + evidence gallery + reserve panel).
      </p>
      <p className="text-xs text-slate-500 mt-3 font-mono">
        case-studies/yotsuba-claims-platform/passes/&lt;pass&gt;/web/src/pages/ClaimDetail.tsx
      </p>
    </div>
  </div>
);
export default ClaimDetailPage;

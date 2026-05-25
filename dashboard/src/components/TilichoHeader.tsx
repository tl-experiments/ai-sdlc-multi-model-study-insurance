import React from "react";

/**
 * Top-of-page header — Tilicho Labs logo + study attribution.
 * Sits above the tab nav so attribution stays visible across views.
 */
export function TilichoHeader() {
  return (
    <div className="bg-white border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-8 py-4 flex items-center gap-4">
        <img
          src="/tilicho-logo.png"
          alt="Tilicho Labs"
          className="h-9 w-auto"
        />
        <div className="border-l border-slate-200 pl-4">
          <div className="text-sm font-semibold text-slate-800">Multi-Model SDLC Orchestrator</div>
          <div className="text-xs text-slate-500">Independent Study by Tilicho Labs</div>
        </div>
      </div>
    </div>
  );
}

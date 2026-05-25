import React from "react";

export function Modal({ open, onClose, title, children, widthClass }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  widthClass?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-xl max-h-[90vh] overflow-auto ${widthClass ?? "w-full max-w-3xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <h3 className="text-lg font-bold">{title}</h3>
          <button onClick={onClose} className="px-3 py-1 rounded text-sm border border-slate-200 hover:bg-slate-50">Close</button>
        </div>
        <div className="px-6 py-5">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * EvidenceGallery.tsx
 * Displays a gallery of evidence items (photos, documents, audio, video) attached to a claim.
 * Used in the ClaimDetail page to show all evidence with preview, metadata, and upload capability.
 */

import React, { useState } from 'react';

/**
 * Evidence kind type matching the backend EvidenceKind enum.
 */
type EvidenceKind = 'photo' | 'document' | 'audio' | 'video' | 'witness_statement_attachment';

/**
 * Evidence item structure matching the backend Evidence model.
 */
interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  content_hash: string;
  blob_ref: string;
  uploaded_by_id: string;
  uploaded_at: string;
  uploaded_by_name?: string;
}

/**
 * Evidence metadata: display name, icon, MIME type hint, and preview capability.
 */
const EVIDENCE_CONFIG: Record<
  EvidenceKind,
  { label: string; icon: string; mimeHint: string; previewable: boolean }
> = {
  photo: {
    label: 'Photo',
    icon: '📷',
    mimeHint: 'image/*',
    previewable: true,
  },
  document: {
    label: 'Document',
    icon: '📄',
    mimeHint: 'application/pdf, application/msword',
    previewable: false,
  },
  audio: {
    label: 'Audio',
    icon: '🎙️',
    mimeHint: 'audio/*',
    previewable: false,
  },
  video: {
    label: 'Video',
    icon: '🎥',
    mimeHint: 'video/*',
    previewable: true,
  },
  witness_statement_attachment: {
    label: 'Witness Statement',
    icon: '👤',
    mimeHint: 'application/pdf, text/plain',
    previewable: false,
  },
};

/**
 * Props for the EvidenceGallery component.
 */
interface EvidenceGalleryProps {
  evidence: EvidenceItem[];
  onUpload?: (file: File, kind: EvidenceKind) => Promise<void>;
  canUpload?: boolean;
  className?: string;
}

/**
 * EvidenceCard component — displays a single evidence item with preview and metadata.
 */
interface EvidenceCardProps {
  item: EvidenceItem;
  onPreview?: (item: EvidenceItem) => void;
}

const EvidenceCard: React.FC<EvidenceCardProps> = ({ item, onPreview }) => {
  const config = EVIDENCE_CONFIG[item.kind];

  if (!config) {
    return null;
  }

  const isPreviewable = config.previewable;
  const uploadedAtDate = new Date(item.uploaded_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden hover:shadow-md transition-shadow bg-white">
      {/* Preview area */}
      <div className="bg-gray-50 h-40 flex items-center justify-center border-b border-gray-200 relative group">
        {isPreviewable && item.kind === 'photo' ? (
          <>
            <img
              src={item.blob_ref}
              alt="Evidence photo"
              className="w-full h-full object-cover"
            />
            <button
              onClick={() => onPreview?.(item)}
              className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
              title="View full size"
            >
              <span className="text-white text-2xl">🔍</span>
            </button>
          </>
        ) : isPreviewable && item.kind === 'video' ? (
          <>
            <video
              src={item.blob_ref}
              className="w-full h-full object-cover"
              controls={false}
            />
            <button
              onClick={() => onPreview?.(item)}
              className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
              title="Play video"
            >
              <span className="text-white text-3xl">▶️</span>
            </button>
          </>
        ) : (
          <div className="text-4xl">{config.icon}</div>
        )}
      </div>

      {/* Metadata */}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">{config.icon}</span>
          <span className="font-medium text-sm text-gray-900">{config.label}</span>
        </div>
        <div className="text-xs text-gray-500 space-y-1">
          <div className="truncate" title={item.content_hash}>
            Hash: {item.content_hash.substring(0, 16)}…
          </div>
          <div>{uploadedAtDate}</div>
          {item.uploaded_by_name && (
            <div className="text-gray-600">By: {item.uploaded_by_name}</div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * EvidenceUploadForm component — form to upload new evidence.
 */
interface EvidenceUploadFormProps {
  onSubmit: (file: File, kind: EvidenceKind) => Promise<void>;
  isLoading?: boolean;
}

const EvidenceUploadForm: React.FC<EvidenceUploadFormProps> = ({ onSubmit, isLoading }) => {
  const [selectedKind, setSelectedKind] = useState<EvidenceKind>('photo');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setError('Please select a file');
      return;
    }

    try {
      await onSubmit(selectedFile, selectedKind);
      setSelectedFile(null);
      setSelectedKind('photo');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
      <h3 className="font-semibold text-gray-900 mb-4">Upload Evidence</h3>

      <div className="space-y-4">
        {/* Evidence kind selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Evidence Type
          </label>
          <select
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value as EvidenceKind)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Object.entries(EVIDENCE_CONFIG).map(([kind, config]) => (
              <option key={kind} value={kind}>
                {config.icon} {config.label}
              </option>
            ))}
          </select>
        </div>

        {/* File input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select File
          </label>
          <input
            type="file"
            onChange={handleFileChange}
            accept={EVIDENCE_CONFIG[selectedKind].mimeHint}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          {selectedFile && (
            <p className="text-xs text-gray-600 mt-1">
              Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
            </p>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Submit button */}
        <button
          type="submit"
          disabled={!selectedFile || isLoading}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? 'Uploading…' : 'Upload Evidence'}
        </button>
      </div>
    </form>
  );
};

/**
 * EvidenceGallery component — displays a gallery of evidence items with upload capability.
 * @param evidence - Array of evidence items to display
 * @param onUpload - Callback when a file is uploaded
 * @param canUpload - Whether the user can upload evidence (default: false)
 * @param className - Additional CSS classes to apply
 * @returns Rendered evidence gallery
 */
export const EvidenceGallery: React.FC<EvidenceGalleryProps> = ({
  evidence,
  onUpload,
  canUpload = false,
  className = '',
}) => {
  const [previewItem, setPreviewItem] = useState<EvidenceItem | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = async (file: File, kind: EvidenceKind) => {
    if (!onUpload) return;
    setIsUploading(true);
    try {
      await onUpload(file, kind);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className={`space-y-6 ${className}`.trim()}>
      {/* Upload form */}
      {canUpload && (
        <EvidenceUploadForm onSubmit={handleUpload} isLoading={isUploading} />
      )}

      {/* Evidence grid */}
      <div>
        <h3 className="font-semibold text-gray-900 mb-4">
          Evidence ({evidence.length})
        </h3>
        {evidence.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
            <p className="text-gray-500 text-sm">No evidence attached yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {evidence.map((item) => (
              <EvidenceCard
                key={item.id}
                item={item}
                onPreview={setPreviewItem}
              />
            ))}
          </div>
        )}
      </div>

      {/* Preview modal */}
      {previewItem && (
        <div
          className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="bg-white rounded-lg max-w-2xl w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Preview header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 sticky top-0 bg-white">
              <div className="flex items-center gap-2">
                <span className="text-2xl">
                  {EVIDENCE_CONFIG[previewItem.kind].icon}
                </span>
                <div>
                  <h3 className="font-semibold text-gray-900">
                    {EVIDENCE_CONFIG[previewItem.kind].label}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {new Date(previewItem.uploaded_at).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setPreviewItem(null)}
                className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
                title="Close"
              >
                ✕
              </button>
            </div>

            {/* Preview content */}
            <div className="p-4">
              {previewItem.kind === 'photo' ? (
                <img
                  src={previewItem.blob_ref}
                  alt="Evidence photo"
                  className="w-full rounded"
                />
              ) : previewItem.kind === 'video' ? (
                <video
                  src={previewItem.blob_ref}
                  controls
                  className="w-full rounded"
                />
              ) : previewItem.kind === 'audio' ? (
                <audio
                  src={previewItem.blob_ref}
                  controls
                  className="w-full"
                />
              ) : (
                <div className="text-center py-12 bg-gray-50 rounded">
                  <p className="text-gray-500 text-sm">
                    Preview not available for {EVIDENCE_CONFIG[previewItem.kind].label.toLowerCase()}
                  </p>
                  <p className="text-xs text-gray-400 mt-2">
                    Hash: {previewItem.content_hash}
                  </p>
                </div>
              )}
            </div>

            {/* Preview footer */}
            <div className="p-4 border-t border-gray-200 bg-gray-50 text-xs text-gray-600 space-y-1">
              <div className="truncate" title={previewItem.content_hash}>
                <strong>Content Hash:</strong> {previewItem.content_hash}
              </div>
              <div>
                <strong>Blob Reference:</strong> {previewItem.blob_ref}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * getEvidenceLabel — utility function to get the display label for an evidence kind.
 * @param kind - The evidence kind
 * @returns Display label
 */
export function getEvidenceLabel(kind: EvidenceKind): string {
  return EVIDENCE_CONFIG[kind]?.label || kind;
}

/**
 * getEvidenceIcon — utility function to get the icon for an evidence kind.
 * @param kind - The evidence kind
 * @returns Icon emoji
 */
export function getEvidenceIcon(kind: EvidenceKind): string {
  return EVIDENCE_CONFIG[kind]?.icon || '📎';
}

/**
 * isEvidencePreviewable — utility function to check if an evidence kind is previewable.
 * @param kind - The evidence kind
 * @returns True if the evidence can be previewed inline
 */
export function isEvidencePreviewable(kind: EvidenceKind): boolean {
  return EVIDENCE_CONFIG[kind]?.previewable || false;
}
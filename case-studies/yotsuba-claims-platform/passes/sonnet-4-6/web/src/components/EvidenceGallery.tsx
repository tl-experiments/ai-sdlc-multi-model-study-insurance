/**
 * EvidenceGallery.tsx
 *
 * Displays a gallery of evidence items attached to a claim.
 *
 * Design constraints:
 *  - Mirrors the five EvidenceKind values from the Prisma schema / API exactly:
 *    photo | document | audio | video | witness_statement_attachment
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Shows content-hash for tamper detection per the brief (sha-256 of blob).
 *  - Blob storage is stubbed — no actual downloads, but blob_ref is displayed.
 *  - Accepts optional callbacks for view/download actions.
 *  - Exports `getEvidenceKindLabel` and `ALL_EVIDENCE_KINDS` for filter chips.
 */

import React, { useState } from 'react';
import type { EvidenceKind } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  content_hash: string;  // sha-256 of the blob; used for tamper detection
  blob_ref: string;      // s3://stub/... reference
  uploaded_by_id: string;
  uploaded_at: string;   // ISO-8601 datetime string
  /** Optional display name for the uploaded-by user. */
  uploaded_by_name?: string;
}

export type GalleryLayout = 'grid' | 'list';

export interface EvidenceGalleryProps {
  /** The evidence items to display. */
  items: EvidenceItem[];
  /**
   * Layout mode.
   * - 'grid': card grid — suitable for photo-heavy evidence sets.
   * - 'list': compact rows — suitable for document-heavy evidence sets.
   * Default: 'grid'.
   */
  layout?: GalleryLayout;
  /**
   * Filter to a specific evidence kind.
   * When undefined, all kinds are shown.
   */
  kindFilter?: EvidenceKind | undefined;
  /**
   * Called when the user clicks the view/open action on an item.
   * Since blob storage is stubbed, the caller can handle this however
   * is appropriate (e.g., show blob_ref in a toast).
   */
  onView?: (item: EvidenceItem) => void;
  /** Additional class names merged onto the root element. */
  className?: string;
}

// ─── Evidence kind config ─────────────────────────────────────────────────────

interface KindConfig {
  /** Human-readable label for the evidence kind. */
  label: string;
  /** Tailwind colour classes for the kind badge. */
  colourClasses: string;
}

/**
 * Visual configuration keyed by EvidenceKind.
 *
 * Colour logic:
 *  - photo                       : blue   — visual media
 *  - document                    : gray   — paperwork / reports
 *  - audio                       : purple — audio recordings
 *  - video                       : indigo — video recordings
 *  - witness_statement_attachment : amber  — witness-related material
 */
const KIND_CONFIG: Record<EvidenceKind, KindConfig> = {
  photo: {
    label: 'Photo',
    colourClasses: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  },
  document: {
    label: 'Document',
    colourClasses: 'bg-gray-50 text-gray-700 ring-gray-500/20',
  },
  audio: {
    label: 'Audio',
    colourClasses: 'bg-purple-50 text-purple-700 ring-purple-600/20',
  },
  video: {
    label: 'Video',
    colourClasses: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  },
  witness_statement_attachment: {
    label: 'Witness Attachment',
    colourClasses: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<EvidenceGallery>` — renders a filterable gallery of evidence items.
 *
 * The gallery supports both grid and list layouts, kind-based filtering via
 * built-in filter chips, and tamper-detection display (content hash).
 * Since blob storage is stubbed, no real file downloads occur; the `onView`
 * callback receives the full item for the caller to handle.
 *
 * @example
 * ```tsx
 * <EvidenceGallery
 *   items={claim.evidence}
 *   layout="grid"
 *   onView={(item) => alert(`Blob ref: ${item.blob_ref}`)}
 * />
 * ```
 */
export function EvidenceGallery({
  items,
  layout = 'grid',
  kindFilter,
  onView,
  className = '',
}: EvidenceGalleryProps): React.ReactElement {
  const [activeKindFilter, setActiveKindFilter] = useState<EvidenceKind | undefined>(
    kindFilter,
  );
  const [activeLayout, setActiveLayout] = useState<GalleryLayout>(layout);

  const filteredItems =
    activeKindFilter === undefined
      ? items
      : items.filter((item) => item.kind === activeKindFilter);

  const rootClasses = ['space-y-4', className].filter(Boolean).join(' ');

  return (
    <div className={rootClasses}>
      {/* Toolbar: kind filter chips + layout toggle */}
      <GalleryToolbar
        items={items}
        activeKindFilter={activeKindFilter}
        onKindFilterChange={setActiveKindFilter}
        activeLayout={activeLayout}
        onLayoutChange={setActiveLayout}
      />

      {/* Empty state */}
      {filteredItems.length === 0 ? (
        <GalleryEmptyState hasItems={items.length > 0} />
      ) : activeLayout === 'grid' ? (
        <GalleryGrid items={filteredItems} onView={onView} />
      ) : (
        <GalleryList items={filteredItems} onView={onView} />
      )}
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

interface GalleryToolbarProps {
  items: EvidenceItem[];
  activeKindFilter: EvidenceKind | undefined;
  onKindFilterChange: (kind: EvidenceKind | undefined) => void;
  activeLayout: GalleryLayout;
  onLayoutChange: (layout: GalleryLayout) => void;
}

function GalleryToolbar({
  items,
  activeKindFilter,
  onKindFilterChange,
  activeLayout,
  onLayoutChange,
}: GalleryToolbarProps): React.ReactElement {
  // Only show filter chips for kinds that actually appear in the item list.
  const presentKinds = ALL_EVIDENCE_KINDS.filter((k) =>
    items.some((item) => item.kind === k),
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* Kind filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onKindFilterChange(undefined)}
          className={[
            'inline-flex items-center gap-x-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
            activeKindFilter === undefined
              ? 'bg-gray-800 text-white ring-gray-700'
              : 'bg-white text-gray-600 ring-gray-300 hover:bg-gray-50',
          ].join(' ')}
        >
          All
          <span
            className={[
              'ml-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold',
              activeKindFilter === undefined
                ? 'bg-gray-600 text-gray-100'
                : 'bg-gray-100 text-gray-600',
            ].join(' ')}
          >
            {items.length}
          </span>
        </button>

        {presentKinds.map((kind) => {
          const count = items.filter((i) => i.kind === kind).length;
          const isActive = activeKindFilter === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onKindFilterChange(isActive ? undefined : kind)}
              className={[
                'inline-flex items-center gap-x-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
                isActive
                  ? 'bg-gray-800 text-white ring-gray-700'
                  : 'bg-white text-gray-600 ring-gray-300 hover:bg-gray-50',
              ].join(' ')}
            >
              <EvidenceKindIcon kind={kind} className="h-3 w-3" />
              {KIND_CONFIG[kind].label}
              <span
                className={[
                  'ml-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold',
                  isActive ? 'bg-gray-600 text-gray-100' : 'bg-gray-100 text-gray-600',
                ].join(' ')}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Layout toggle */}
      <div className="flex items-center rounded-lg ring-1 ring-gray-200 overflow-hidden">
        <button
          type="button"
          title="Grid view"
          onClick={() => onLayoutChange('grid')}
          className={[
            'p-1.5 transition-colors',
            activeLayout === 'grid'
              ? 'bg-gray-800 text-white'
              : 'bg-white text-gray-500 hover:bg-gray-50',
          ].join(' ')}
        >
          <GridIcon className="h-4 w-4" />
          <span className="sr-only">Grid view</span>
        </button>
        <button
          type="button"
          title="List view"
          onClick={() => onLayoutChange('list')}
          className={[
            'p-1.5 transition-colors',
            activeLayout === 'list'
              ? 'bg-gray-800 text-white'
              : 'bg-white text-gray-500 hover:bg-gray-50',
          ].join(' ')}
        >
          <ListIcon className="h-4 w-4" />
          <span className="sr-only">List view</span>
        </button>
      </div>
    </div>
  );
}

// ─── Grid layout ──────────────────────────────────────────────────────────────

interface GalleryGridProps {
  items: EvidenceItem[];
  onView?: (item: EvidenceItem) => void;
}

function GalleryGrid({ items, onView }: GalleryGridProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <EvidenceCard key={item.id} item={item} onView={onView} />
      ))}
    </div>
  );
}

// ─── List layout ──────────────────────────────────────────────────────────────

interface GalleryListProps {
  items: EvidenceItem[];
  onView?: (item: EvidenceItem) => void;
}

function GalleryList({ items, onView }: GalleryListProps): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <ul className="divide-y divide-gray-100">
        {items.map((item) => (
          <EvidenceRow key={item.id} item={item} onView={onView} />
        ))}
      </ul>
    </div>
  );
}

// ─── Evidence card (grid item) ────────────────────────────────────────────────

interface EvidenceCardProps {
  item: EvidenceItem;
  onView?: (item: EvidenceItem) => void;
}

function EvidenceCard({ item, onView }: EvidenceCardProps): React.ReactElement {
  const config = KIND_CONFIG[item.kind];
  const formattedDate = formatUploadedAt(item.uploaded_at);
  const shortHash = item.content_hash.slice(0, 12);

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      {/* Kind icon area */}
      <div className="flex h-32 items-center justify-center bg-gray-50 border-b border-gray-100">
        <EvidenceKindIcon
          kind={item.kind}
          className="h-12 w-12 text-gray-300"
          aria-hidden
        />
      </div>

      {/* Card body */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        {/* Kind badge */}
        <span
          className={[
            'self-start inline-flex items-center gap-x-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
            config.colourClasses,
          ].join(' ')}
        >
          <EvidenceKindIcon kind={item.kind} className="h-3 w-3" />
          {config.label}
        </span>

        {/* Blob ref (truncated) */}
        <p
          className="truncate text-xs text-gray-500 font-mono"
          title={item.blob_ref}
        >
          {item.blob_ref}
        </p>

        {/* Content hash — tamper detection */}
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <HashIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
          <span
            className="font-mono truncate"
            title={`SHA-256: ${item.content_hash}`}
          >
            {shortHash}…
          </span>
        </div>

        {/* Upload metadata */}
        <div className="mt-auto flex items-center justify-between text-xs text-gray-400">
          <span title={item.uploaded_at}>{formattedDate}</span>
          {item.uploaded_by_name && (
            <span className="truncate ml-2 text-right" title={item.uploaded_by_id}>
              {item.uploaded_by_name}
            </span>
          )}
        </div>
      </div>

      {/* View action overlay */}
      {onView && (
        <button
          type="button"
          onClick={() => onView(item)}
          className="absolute inset-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
          aria-label={`View ${config.label} evidence (${shortHash}…)`}
        >
          <span className="absolute inset-x-0 bottom-0 h-0 bg-indigo-600/5 transition-all group-hover:h-full" />
        </button>
      )}

      {/* View button in bottom-right, visible on hover */}
      {onView && (
        <div className="pointer-events-none absolute bottom-3 right-3 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white shadow">
            <ExternalLinkIcon className="h-3 w-3" />
            View
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Evidence row (list item) ─────────────────────────────────────────────────

interface EvidenceRowProps {
  item: EvidenceItem;
  onView?: (item: EvidenceItem) => void;
}

function EvidenceRow({ item, onView }: EvidenceRowProps): React.ReactElement {
  const config = KIND_CONFIG[item.kind];
  const formattedDate = formatUploadedAt(item.uploaded_at);
  const shortHash = item.content_hash.slice(0, 12);

  return (
    <li className="group flex items-center gap-4 px-4 py-3 hover:bg-gray-50 transition-colors">
      {/* Kind icon */}
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100">
        <EvidenceKindIcon kind={item.kind} className="h-5 w-5 text-gray-500" />
      </div>

      {/* Main content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Kind badge */}
          <span
            className={[
              'inline-flex items-center gap-x-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
              config.colourClasses,
            ].join(' ')}
          >
            {config.label}
          </span>

          {/* Blob ref */}
          <span
            className="truncate text-xs font-mono text-gray-500"
            title={item.blob_ref}
          >
            {item.blob_ref}
          </span>
        </div>

        <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
          {/* Content hash */}
          <span
            className="inline-flex items-center gap-1 font-mono"
            title={`SHA-256: ${item.content_hash}`}
          >
            <HashIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
            {shortHash}…
          </span>

          {/* Upload date */}
          <span title={item.uploaded_at}>{formattedDate}</span>

          {/* Uploader */}
          {item.uploaded_by_name && (
            <span className="truncate" title={item.uploaded_by_id}>
              {item.uploaded_by_name}
            </span>
          )}
        </div>
      </div>

      {/* View action */}
      {onView && (
        <button
          type="button"
          onClick={() => onView(item)}
          className="flex-shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-500 ring-1 ring-inset ring-gray-200 hover:bg-white hover:text-indigo-600 hover:ring-indigo-300 transition-colors"
          aria-label={`View ${config.label} evidence (${shortHash}…)`}
        >
          <ExternalLinkIcon className="h-3 w-3" />
          View
        </button>
      )}
    </li>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

interface GalleryEmptyStateProps {
  /** True if items exist but the current filter returns none. */
  hasItems: boolean;
}

function GalleryEmptyState({ hasItems }: GalleryEmptyStateProps): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
        <PhotoIcon className="h-6 w-6 text-gray-400" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-700">
          {hasItems ? 'No evidence matches the current filter' : 'No evidence attached'}
        </p>
        <p className="mt-1 text-xs text-gray-400">
          {hasItems
            ? 'Try selecting a different kind filter or clearing the filter.'
            : 'Evidence items will appear here once attached by an adjuster.'}
        </p>
      </div>
    </div>
  );
}

// ─── SVG icon helpers ─────────────────────────────────────────────────────────

interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

/**
 * Kind-specific SVG icon for each EvidenceKind.
 * All icons use `currentColor` for easy colour inheritance.
 */
export function EvidenceKindIcon({
  kind,
  className = 'h-5 w-5',
  ...rest
}: IconProps & { kind: EvidenceKind }): React.ReactElement {
  switch (kind) {
    case 'photo':
      return (
        <svg
          className={className}
          viewBox="0 0 20 20"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          {...rest}
        >
          <path
            fillRule="evenodd"
            d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'document':
      return (
        <svg
          className={className}
          viewBox="0 0 20 20"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          {...rest}
        >
          <path
            fillRule="evenodd"
            d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'audio':
      return (
        <svg
          className={className}
          viewBox="0 0 20 20"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          {...rest}
        >
          <path
            fillRule="evenodd"
            d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'video':
      return (
        <svg
          className={className}
          viewBox="0 0 20 20"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          {...rest}
        >
          <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14.553 7.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z" />
        </svg>
      );

    case 'witness_statement_attachment':
      return (
        <svg
          className={className}
          viewBox="0 0 20 20"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          {...rest}
        >
          <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
        </svg>
      );

    default: {
      // TypeScript exhaustiveness check — `kind` is `never` here.
      const _exhaustive: never = kind;
      void _exhaustive;
      return <span className={className} />;
    }
  }
}

function PhotoIcon({ className = 'h-5 w-5', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function HashIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M9.243 3.03a1 1 0 01.727 1.213L9.53 6h2.94l.56-2.243a1 1 0 111.94.486L14.53 6H17a1 1 0 110 2h-2.97l-1 4H15a1 1 0 110 2h-2.47l-.56 2.242a1 1 0 11-1.94-.485L10.47 14H7.53l-.56 2.242a1 1 0 11-1.94-.485L5.47 14H3a1 1 0 110-2h2.97l1-4H5a1 1 0 010-2h2.47l.56-2.243a1 1 0 011.213-.727zM9.03 8l-1 4h2.938l1-4H9.031z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ExternalLinkIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
      <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
    </svg>
  );
}

function GridIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  );
}

function ListIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format an ISO-8601 datetime string into a short, human-readable date.
 * Falls back to the raw string if the date is unparseable.
 */
function formatUploadedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ─── Convenience exports ──────────────────────────────────────────────────────

/**
 * Ordered list of all valid EvidenceKind values.
 * Useful for rendering kind filter chips or select options.
 */
export const ALL_EVIDENCE_KINDS: EvidenceKind[] = [
  'photo',
  'document',
  'audio',
  'video',
  'witness_statement_attachment',
];

/**
 * Return the human-readable label for an evidence kind without rendering a
 * full badge.
 * Useful in `aria-label` strings and table header tooltips.
 *
 * @example
 * ```tsx
 * <option value={kind}>{getEvidenceKindLabel(kind)}</option>
 * ```
 */
export function getEvidenceKindLabel(kind: EvidenceKind): string {
  return KIND_CONFIG[kind].label;
}
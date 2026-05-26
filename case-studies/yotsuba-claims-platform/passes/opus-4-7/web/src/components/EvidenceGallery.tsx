/**
 * EvidenceGallery — read-only grid view of evidence attached to a claim.
 *
 * Why this component exists
 * -------------------------
 * The Adjuster Workbench's claim detail page renders a timeline of notes,
 * a reserve breakdown, and — via this component — the evidence the
 * adjuster (and others) have attached to the claim. Evidence items are
 * stored by SHA-256 content-hash (see `Evidence` in the Prisma schema and
 * the brief's "S3-compatible blob stub" note); the actual binary lives
 * in stubbed blob storage and is referenced by an opaque `blob_ref`
 * string. This component is therefore deliberately *not* a media viewer —
 * it surfaces the metadata that matters for review:
 *
 *   - **Kind** — photo / document / audio / video / witness statement
 *     attachment. Drives the icon and colour treatment.
 *   - **Content hash** — the tamper-detection anchor. Reviewers want to
 *     see at a glance that the hash is recorded; the full 64-char value
 *     is available on hover / focus, but the card shows a truncated
 *     prefix so the grid stays scannable.
 *   - **Blob ref** — the storage pointer (e.g. `s3://stub/...`). Useful
 *     for support staff tracing a file through the stubbed pipeline.
 *   - **Uploader + timestamp** — provenance, which is the whole point of
 *     attaching evidence in the first place.
 *
 * The component is purely presentational. It receives an array of
 * `Evidence` records (the same shape the API layer exports) and renders
 * a responsive Tailwind grid. No hooks, no context, no network calls —
 * the parent page (`ClaimDetail.tsx`) is responsible for fetching and
 * for wiring any upload affordance.
 *
 * Accessibility
 * -------------
 * Each card is an `<article>` with a descriptive `aria-label` so screen
 * readers announce "Photo evidence, uploaded 2024-… by …" rather than a
 * wall of metadata. The icon is `aria-hidden`; the textual kind label
 * carries the meaning.
 */

import type { Evidence, EvidenceKind } from '../lib/api';

// ─────────────────────────── kind descriptor ───────────────────────────

/**
 * Internal lookup mapping each `EvidenceKind` to its display label,
 * Tailwind colour classes for the kind chip, and a small inline SVG
 * glyph. Centralised so palette / iconography changes are one edit; the
 * `Record<EvidenceKind, …>` type catches a missing entry at compile
 * time when the enum is extended (Track B may add e.g. `telematics`).
 *
 * Colour rationale (kept distinct from the status / severity / role
 * palettes so an evidence card sitting next to those pills reads as a
 * separate dimension):
 *   - `photo`                          — sky:     visual record.
 *   - `document`                       — slate:   paperwork, reports.
 *   - `audio`                          — violet:  call recordings.
 *   - `video`                          — indigo:  dashcam, CCTV.
 *   - `witness_statement_attachment`   — amber:   supports a witness
 *                                                  statement; warm tone
 *                                                  to associate visually
 *                                                  with the inkan-sealed
 *                                                  statement record.
 */
interface KindDescriptor {
  readonly label: string;
  readonly chipClasses: string;
  readonly icon: JSX.Element;
}

const PhotoIcon: JSX.Element = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M8 5l1.5-2h5L16 5" />
  </svg>
);

const DocumentIcon: JSX.Element = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <path d="M7 3h7l4 4v14H7z" />
    <path d="M14 3v4h4" />
    <path d="M9 12h6M9 16h6M9 8h2" />
  </svg>
);

const AudioIcon: JSX.Element = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3M9 21h6" />
  </svg>
);

const VideoIcon: JSX.Element = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10l5-3v10l-5-3z" />
  </svg>
);

const WitnessIcon: JSX.Element = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
    <path d="M16.5 4.5l1.5 1.5-1.5 1.5" />
  </svg>
);

const KIND_DESCRIPTORS: Record<EvidenceKind, KindDescriptor> = {
  photo: {
    label: 'Photo',
    chipClasses: 'bg-sky-100 text-sky-800 ring-sky-200',
    icon: PhotoIcon,
  },
  document: {
    label: 'Document',
    chipClasses: 'bg-slate-100 text-slate-700 ring-slate-200',
    icon: DocumentIcon,
  },
  audio: {
    label: 'Audio',
    chipClasses: 'bg-violet-100 text-violet-800 ring-violet-200',
    icon: AudioIcon,
  },
  video: {
    label: 'Video',
    chipClasses: 'bg-indigo-100 text-indigo-800 ring-indigo-200',
    icon: VideoIcon,
  },
  witness_statement_attachment: {
    label: 'Witness Statement Attachment',
    chipClasses: 'bg-amber-100 text-amber-800 ring-amber-200',
    icon: WitnessIcon,
  },
};

const UNKNOWN_KIND_DESCRIPTOR: KindDescriptor = {
  label: 'Unknown',
  chipClasses: 'bg-slate-100 text-slate-500 ring-slate-200',
  icon: DocumentIcon,
};

function resolveKindDescriptor(kind: EvidenceKind | string): KindDescriptor {
  const known = (KIND_DESCRIPTORS as Record<string, KindDescriptor | undefined>)[kind];
  if (known) {
    return known;
  }
  return { ...UNKNOWN_KIND_DESCRIPTOR, label: kind || UNKNOWN_KIND_DESCRIPTOR.label };
}

// ─────────────────────────── formatting helpers ────────────────────────

/**
 * Render a SHA-256 hash as a compact prefix…suffix for grid display.
 * The full value is preserved on the `title` attribute so reviewers
 * can copy it for verification.
 */
function shortenHash(hash: string): string {
  if (hash.length <= 16) {
    return hash;
  }
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

/**
 * Format an ISO timestamp for display. Uses the user's locale so a
 * Tokyo-based adjuster sees JST, while an auditor in London sees BST.
 * Falls back to the raw string if parsing fails so a malformed value
 * surfaces visibly rather than vanishing.
 */
function formatUploadedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─────────────────────────── component props ───────────────────────────

export interface EvidenceGalleryProps {
  /**
   * The evidence records to display. Typically sourced from
   * `GET /claims/:id`'s embedded `evidence` array. An empty array
   * renders the empty-state panel rather than an empty grid.
   */
  items: readonly Evidence[];
  /**
   * Optional lookup from user id → display name so cards can show
   * "Uploaded by Tanaka Hiroshi" rather than a bare cuid. When the
   * lookup is missing or the id is unknown, the raw id is shown
   * (truncated) so support staff retain traceability.
   */
  uploaderNames?: Readonly<Record<string, string>>;
  /**
   * Additional Tailwind classes appended to the root element. Lets the
   * parent page tweak spacing without forking the component.
   */
  className?: string;
  /**
   * Optional copy shown in the empty-state panel. Defaults to a
   * neutral message; the parent may override it to e.g. instruct an
   * adjuster to attach the first piece of evidence.
   */
  emptyStateMessage?: string;
}

// ───────────────────────────── component ───────────────────────────────

/**
 * Resolve an uploader id to a display string. Truncates unknown ids so
 * a card never overflows its column.
 */
function resolveUploader(
  id: string,
  uploaderNames: Readonly<Record<string, string>> | undefined,
): string {
  const name = uploaderNames?.[id];
  if (name && name.length > 0) {
    return name;
  }
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 8)}…`;
}

/**
 * Render the read-only evidence gallery.
 *
 * @example
 *   <EvidenceGallery items={claim.evidence} uploaderNames={userNames} />
 */
export function EvidenceGallery({
  items,
  uploaderNames,
  className,
  emptyStateMessage = 'No evidence has been attached to this claim yet.',
}: EvidenceGalleryProps): JSX.Element {
  const rootClassName = ['w-full', className ?? ''].filter((part) => part.length > 0).join(' ');

  if (items.length === 0) {
    return (
      <div
        className={rootClassName}
        role="region"
        aria-label="Evidence gallery"
      >
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
          <p className="text-sm text-slate-500">{emptyStateMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={rootClassName} role="region" aria-label="Evidence gallery">
      <ul
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        role="list"
      >
        {items.map((item) => {
          const descriptor = resolveKindDescriptor(item.kind);
          const uploadedAt = formatUploadedAt(item.uploaded_at);
          const uploaderLabel = resolveUploader(item.uploaded_by_id, uploaderNames);
          const ariaLabel = `${descriptor.label} evidence, uploaded ${uploadedAt} by ${uploaderLabel}`;

          return (
            <li key={item.id} role="listitem">
              <article
                aria-label={ariaLabel}
                className="flex h-full flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
              >
                <header className="flex items-start justify-between gap-2">
                  <span
                    className={[
                      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap',
                      descriptor.chipClasses,
                    ].join(' ')}
                  >
                    <span aria-hidden="true">{descriptor.icon}</span>
                    <span>{descriptor.label}</span>
                  </span>
                  <time
                    dateTime={item.uploaded_at}
                    className="text-xs text-slate-500"
                    title={item.uploaded_at}
                  >
                    {uploadedAt}
                  </time>
                </header>

                <dl className="flex flex-1 flex-col gap-2 text-xs">
                  <div>
                    <dt className="font-medium uppercase tracking-wide text-slate-500">
                      Content hash
                    </dt>
                    <dd
                      className="mt-0.5 break-all font-mono text-slate-800"
                      title={item.content_hash}
                    >
                      {shortenHash(item.content_hash)}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-medium uppercase tracking-wide text-slate-500">
                      Blob ref
                    </dt>
                    <dd
                      className="mt-0.5 truncate font-mono text-slate-700"
                      title={item.blob_ref}
                    >
                      {item.blob_ref}
                    </dd>
                  </div>

                  <div className="mt-auto">
                    <dt className="font-medium uppercase tracking-wide text-slate-500">
                      Uploaded by
                    </dt>
                    <dd
                      className="mt-0.5 truncate text-slate-700"
                      title={item.uploaded_by_id}
                    >
                      {uploaderLabel}
                    </dd>
                  </div>
                </dl>
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default EvidenceGallery;
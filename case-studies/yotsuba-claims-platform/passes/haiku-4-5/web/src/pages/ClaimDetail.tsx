/**
 * ClaimDetail.tsx
 * Displays the full detail view of a single claim for the adjuster workbench.
 * Includes claim information, timeline, notes, evidence gallery, witness statements, and reserves.
 * Provides actions for status transitions, note addition, evidence upload, and reserve proposals.
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Layout, PageHeader, Card, Badge, Section } from '../components/Layout';
import { formatYen } from '../lib/format-yen';

/**
 * Claim detail type matching the backend Claim model.
 */
interface ClaimDetail {
  id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reported_by_channel: 'agent' | 'mobile' | 'broker' | 'email';
  reporter_name: string;
  reporter_phone?: string;
  reporter_email?: string;
  reporter_relation_to_insured: string;
  incident_type: string;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number?: string;
  severity_initial: 'simple' | 'complex' | 'catastrophic';
  status: ClaimStatus;
  assigned_adjuster_id?: string;
  created_at: string;
  updated_at: string;
}

type ClaimStatus =
  | 'intake'
  | 'under_investigation'
  | 'awaiting_reserve_approval'
  | 'settlement_offered'
  | 'closed_paid'
  | 'closed_denied'
  | 'reopened';

/**
 * Claim note type.
 */
interface ClaimNote {
  id: string;
  claim_id: string;
  author_id: string;
  body: string;
  created_at: string;
}

/**
 * Evidence type.
 */
interface Evidence {
  id: string;
  claim_id: string;
  kind: 'photo' | 'document' | 'audio' | 'video' | 'witness_statement_attachment';
  content_hash: string;
  blob_ref: string;
  uploaded_by_id: string;
  uploaded_at: string;
}

/**
 * Witness statement type.
 */
interface WitnessStatement {
  id: string;
  claim_id: string;
  witness_name: string;
  witness_phone?: string;
  statement_body: string;
  inkan_seal_hash: string;
  recorded_by_id: string;
  recorded_at: string;
}

/**
 * Reserve type.
 */
interface Reserve {
  id: string;
  claim_id: string;
  category: 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae';
  proposed_yen: string;
  prior_yen?: string;
  justification: string;
  proposed_by_id: string;
  proposed_at: string;
  approval_status: 'pending' | 'approved' | 'rejected';
  approved_by_id?: string;
  approved_at?: string;
  director_approved_by_id?: string;
  director_approved_at?: string;
  reason_for_rejection?: string;
}

/**
 * Metadata for claim statuses.
 */
const STATUS_CONFIG: Record<
  ClaimStatus,
  { label: string; color: string; icon: string }
> = {
  intake: { label: 'Intake', color: 'bg-blue-100 text-blue-800', icon: '📥' },
  under_investigation: {
    label: 'Under Investigation',
    color: 'bg-yellow-100 text-yellow-800',
    icon: '🔍',
  },
  awaiting_reserve_approval: {
    label: 'Awaiting Reserve Approval',
    color: 'bg-orange-100 text-orange-800',
    icon: '⏳',
  },
  settlement_offered: {
    label: 'Settlement Offered',
    color: 'bg-purple-100 text-purple-800',
    icon: '💬',
  },
  closed_paid: {
    label: 'Closed - Paid',
    color: 'bg-green-100 text-green-800',
    icon: '✅',
  },
  closed_denied: {
    label: 'Closed - Denied',
    color: 'bg-red-100 text-red-800',
    icon: '❌',
  },
  reopened: {
    label: 'Reopened',
    color: 'bg-pink-100 text-pink-800',
    icon: '🔄',
  },
};

/**
 * Metadata for claim severity.
 */
const SEVERITY_CONFIG: Record<
  'simple' | 'complex' | 'catastrophic',
  { label: string; color: string; icon: string }
> = {
  simple: { label: 'Simple', color: 'bg-green-100 text-green-800', icon: '✓' },
  complex: {
    label: 'Complex',
    color: 'bg-yellow-100 text-yellow-800',
    icon: '⚠',
  },
  catastrophic: {
    label: 'Catastrophic',
    color: 'bg-red-100 text-red-800',
    icon: '🚨',
  },
};

/**
 * Metadata for intake channels.
 */
const CHANNEL_CONFIG: Record<
  'agent' | 'mobile' | 'broker' | 'email',
  { label: string; icon: string }
> = {
  agent: { label: 'Agent', icon: '☎️' },
  mobile: { label: 'Mobile App', icon: '📱' },
  broker: { label: 'Broker', icon: '🤝' },
  email: { label: 'Email', icon: '📧' },
};

/**
 * Metadata for incident types.
 */
const INCIDENT_TYPE_CONFIG: Record<string, { label: string }> = {
  auto_collision: { label: 'Auto Collision' },
  auto_property_damage: { label: 'Auto Property Damage' },
  fire_residential: { label: 'Fire - Residential' },
  fire_commercial: { label: 'Fire - Commercial' },
  marine_cargo: { label: 'Marine Cargo' },
  liability_premises: { label: 'Liability - Premises' },
  personal_accident: { label: 'Personal Accident' },
};

/**
 * Metadata for reserve categories.
 */
const RESERVE_CATEGORY_CONFIG: Record<
  'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae',
  { label: string; description: string }
> = {
  loss_paid: { label: 'Loss Paid', description: 'Amounts already paid out' },
  loss_unpaid: {
    label: 'Loss Unpaid',
    description: 'Estimated future loss payments',
  },
  alae: {
    label: 'ALAE',
    description: 'Allocated Loss Adjustment Expense',
  },
  ulae: {
    label: 'ULAE',
    description: 'Unallocated Loss Adjustment Expense',
  },
};

/**
 * Props for the ClaimInfoSection component.
 */
interface ClaimInfoSectionProps {
  claim: ClaimDetail;
}

/**
 * ClaimInfoSection component — displays basic claim information.
 */
const ClaimInfoSection: React.FC<ClaimInfoSectionProps> = ({ claim }) => {
  const statusConfig = STATUS_CONFIG[claim.status];
  const severityConfig = SEVERITY_CONFIG[claim.severity_initial];
  const channelConfig = CHANNEL_CONFIG[claim.reported_by_channel];
  const incidentConfig = INCIDENT_TYPE_CONFIG[claim.incident_type];

  const lossDate = new Date(claim.loss_date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <Card title="Claim Information">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left column */}
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Claim ID
            </label>
            <p className="text-sm font-mono text-gray-900">{claim.id}</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Policy Number
            </label>
            <p className="text-sm font-medium text-gray-900">
              {claim.policy_number}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Status
            </label>
            <div className="flex items-center gap-2">
              <span className="text-lg">{statusConfig.icon}</span>
              <Badge variant="info">{statusConfig.label}</Badge>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Severity
            </label>
            <div className="flex items-center gap-2">
              <span className="text-lg">{severityConfig.icon}</span>
              <Badge variant="warning">{severityConfig.label}</Badge>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Incident Type
            </label>
            <p className="text-sm text-gray-900">
              {incidentConfig?.label || claim.incident_type}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Loss Date
            </label>
            <p className="text-sm text-gray-900">{lossDate}</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Reported By
            </label>
            <div className="flex items-center gap-2">
              <span className="text-lg">{channelConfig.icon}</span>
              <p className="text-sm text-gray-900">{channelConfig.label}</p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Location
            </label>
            <p className="text-sm text-gray-900">
              {claim.loss_location_prefecture}, {claim.loss_location_postal_code}
            </p>
          </div>
        </div>
      </div>

      {/* Additional details */}
      <div className="mt-6 pt-6 border-t border-gray-200 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
            Location Detail
          </label>
          <p className="text-sm text-gray-700">{claim.loss_location_detail}</p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
            Initial Description
          </label>
          <p className="text-sm text-gray-700">{claim.initial_description}</p>
        </div>

        {/* Flags */}
        <div className="flex gap-4">
          {claim.injury_reported && (
            <div className="flex items-center gap-2 p-2 bg-red-50 rounded">
              <span className="text-lg">🚑</span>
              <span className="text-xs font-medium text-red-700">
                Injury Reported
              </span>
            </div>
          )}
          {claim.third_party_involved && (
            <div className="flex items-center gap-2 p-2 bg-orange-50 rounded">
              <span className="text-lg">👥</span>
              <span className="text-xs font-medium text-orange-700">
                Third Party Involved
              </span>
            </div>
          )}
          {claim.police_report_number && (
            <div className="flex items-center gap-2 p-2 bg-blue-50 rounded">
              <span className="text-lg">🚔</span>
              <span className="text-xs font-medium text-blue-700">
                Police Report: {claim.police_report_number}
              </span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

/**
 * Props for the ReporterInfoSection component.
 */
interface ReporterInfoSectionProps {
  claim: ClaimDetail;
}

/**
 * ReporterInfoSection component — displays reporter information.
 */
const ReporterInfoSection: React.FC<ReporterInfoSectionProps> = ({ claim }) => {
  return (
    <Card title="Reporter Information">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
            Name
          </label>
          <p className="text-sm text-gray-900">{claim.reporter_name}</p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
            Relation to Insured
          </label>
          <p className="text-sm text-gray-900">
            {claim.reporter_relation_to_insured}
          </p>
        </div>

        {claim.reporter_phone && (
          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Phone
            </label>
            <p className="text-sm text-gray-900">{claim.reporter_phone}</p>
          </div>
        )}

        {claim.reporter_email && (
          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Email
            </label>
            <p className="text-sm text-gray-900">{claim.reporter_email}</p>
          </div>
        )}
      </div>
    </Card>
  );
};

/**
 * Props for the NotesSection component.
 */
interface NotesSectionProps {
  claimId: string;
  notes: ClaimNote[];
  isLoading: boolean;
  onAddNote: (body: string) => Promise<void>;
  canAddNote: boolean;
}

/**
 * NotesSection component — displays and allows adding notes to a claim.
 */
const NotesSection: React.FC<NotesSectionProps> = ({
  claimId,
  notes,
  isLoading,
  onAddNote,
  canAddNote,
}) => {
  const [noteBody, setNoteBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAddNote = async () => {
    if (!noteBody.trim()) return;

    setIsSubmitting(true);
    try {
      await onAddNote(noteBody);
      setNoteBody('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card title="Notes" subtitle="Immutable claim notes and updates">
      <div className="space-y-4">
        {/* Add note form */}
        {canAddNote && (
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Add a note to this claim…"
              disabled={isSubmitting}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
              rows={3}
            />
            <div className="mt-3 flex justify-end">
              <button
                onClick={handleAddNote}
                disabled={!noteBody.trim() || isSubmitting}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? '⏳ Adding…' : '➕ Add Note'}
              </button>
            </div>
          </div>
        )}

        {/* Notes list */}
        {isLoading ? (
          <p className="text-sm text-gray-500 text-center py-4">Loading notes…</p>
        ) : notes.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No notes yet</p>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => {
              const noteDate = new Date(note.created_at).toLocaleDateString(
                'en-US',
                {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }
              );

              return (
                <div
                  key={note.id}
                  className="p-3 bg-gray-50 rounded-lg border border-gray-200"
                >
                  <div className="flex items-start justify-between mb-2">
                    <p className="text-xs font-medium text-gray-600">
                      {noteDate}
                    </p>
                    <p className="text-xs text-gray-500">By {note.author_id}</p>
                  </div>
                  <p className="text-sm text-gray-700">{note.body}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
};

/**
 * Props for the EvidenceSection component.
 */
interface EvidenceSectionProps {
  claimId: string;
  evidence: Evidence[];
  isLoading: boolean;
  canAddEvidence: boolean;
}

/**
 * EvidenceSection component — displays evidence attached to a claim.
 */
const EvidenceSection: React.FC<EvidenceSectionProps> = ({
  claimId,
  evidence,
  isLoading,
  canAddEvidence,
}) => {
  const getEvidenceIcon = (
    kind: 'photo' | 'document' | 'audio' | 'video' | 'witness_statement_attachment'
  ): string => {
    switch (kind) {
      case 'photo':
        return '📷';
      case 'document':
        return '📄';
      case 'audio':
        return '🎙️';
      case 'video':
        return '🎥';
      case 'witness_statement_attachment':
        return '📋';
      default:
        return '📎';
    }
  };

  const getEvidenceLabel = (
    kind: 'photo' | 'document' | 'audio' | 'video' | 'witness_statement_attachment'
  ): string => {
    switch (kind) {
      case 'photo':
        return 'Photo';
      case 'document':
        return 'Document';
      case 'audio':
        return 'Audio';
      case 'video':
        return 'Video';
      case 'witness_statement_attachment':
        return 'Witness Statement';
      default:
        return 'Evidence';
    }
  };

  return (
    <Card title="Evidence" subtitle="Attached documents and media">
      <div className="space-y-4">
        {canAddEvidence && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
            <p className="text-sm text-blue-700 font-medium mb-2">
              📎 Evidence upload stubbed
            </p>
            <p className="text-xs text-blue-600">
              In production, attach photos, documents, and other evidence here
            </p>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-gray-500 text-center py-4">
            Loading evidence…
          </p>
        ) : evidence.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            No evidence attached
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {evidence.map((item) => {
              const uploadDate = new Date(item.uploaded_at).toLocaleDateString(
                'en-US',
                {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                }
              );

              return (
                <div
                  key={item.id}
                  className="p-4 bg-gray-50 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">
                      {getEvidenceIcon(item.kind)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {getEvidenceLabel(item.kind)}
                      </p>
                      <p className="text-xs text-gray-600 mt-1">
                        Uploaded {uploadDate}
                      </p>
                      <p className="text-xs text-gray-500 font-mono mt-1 truncate">
                        {item.content_hash.substring(0, 16)}…
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
};

/**
 * Props for the WitnessStatementsSection component.
 */
interface WitnessStatementsSectionProps {
  claimId: string;
  statements: WitnessStatement[];
  isLoading: boolean;
  canAddStatement: boolean;
}

/**
 * WitnessStatementsSection component — displays witness statements.
 */
const WitnessStatementsSection: React.FC<WitnessStatementsSectionProps> = ({
  claimId,
  statements,
  isLoading,
  canAddStatement,
}) => {
  return (
    <Card title="Witness Statements" subtitle="Recorded witness accounts">
      <div className="space-y-4">
        {canAddStatement && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
            <p className="text-sm text-blue-700 font-medium mb-2">
              🗣️ Witness statement intake stubbed
            </p>
            <p className="text-xs text-blue-600">
              In production, record structured witness statements with inkan seal
              acknowledgement here
            </p>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-gray-500 text-center py-4">
            Loading statements…
          </p>
        ) : statements.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            No witness statements recorded
          </p>
        ) : (
          <div className="space-y-4">
            {statements.map((statement) => {
              const recordedDate = new Date(
                statement.recorded_at
              ).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });

              return (
                <div
                  key={statement.id}
                  className="p-4 bg-gray-50 rounded-lg border border-gray-200"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {statement.witness_name}
                      </p>
                      <p className="text-xs text-gray-600 mt-1">
                        Recorded {recordedDate}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 px-2 py-1 bg-green-50 rounded">
                      <span className="text-sm">🔐</span>
                      <span className="text-xs font-medium text-green-700">
                        Sealed
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-700 mb-2">
                    {statement.statement_body}
                  </p>
                  <p className="text-xs text-gray-500 font-mono">
                    Seal: {statement.inkan_seal_hash.substring(0, 16)}…
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
};

/**
 * Props for the ReservesSection component.
 */
interface ReservesSectionProps {
  claimId: string;
  reserves: Reserve[];
  isLoading: boolean;
  canProposeReserve: boolean;
}

/**
 * ReservesSection component — displays and allows proposing reserves.
 */
const ReservesSection: React.FC<ReservesSectionProps> = ({
  claimId,
  reserves,
  isLoading,
  canProposeReserve,
}) => {
  const [showProposeForm, setShowProposeForm] = useState(false);
  const [formData, setFormData] = useState({
    category: 'loss_unpaid' as const,
    proposed_yen: '',
    justification: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleProposeReserve = async () => {
    if (!formData.proposed_yen || !formData.justification.trim()) return;

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('No authentication token');

      const response = await fetch(`/api/claims/${claimId}/reserves`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          category: formData.category,
          proposed_yen: parseInt(formData.proposed_yen, 10),
          justification: formData.justification,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to propose reserve');
      }

      setFormData({
        category: 'loss_unpaid',
        proposed_yen: '',
        justification: '',
      });
      setShowProposeForm(false);
      // Trigger refresh of reserves
      window.location.reload();
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalReserves = reserves
    .filter((r) => r.approval_status === 'approved')
    .reduce((sum, r) => sum + parseInt(r.proposed_yen, 10), 0);

  return (
    <Card title="Reserves" subtitle="Case reserves and ALAE/ULAE">
      <div className="space-y-4">
        {/* Total reserves summary */}
        {reserves.length > 0 && (
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-1">
              Total Approved Reserves
            </p>
            <p className="text-2xl font-bold text-blue-900">
              {formatYen(totalReserves)}
            </p>
          </div>
        )}

        {/* Propose reserve form */}
        {canProposeReserve && (
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            {!showProposeForm ? (
              <button
                onClick={() => setShowProposeForm(true)}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                ➕ Propose Reserve Change
              </button>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
                    Category
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        category: e.target.value as any,
                      })
                    }
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  >
                    {Object.entries(RESERVE_CATEGORY_CONFIG).map(
                      ([key, config]) => (
                        <option key={key} value={key}>
                          {config.label} — {config.description}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
                    Proposed Amount (¥)
                  </label>
                  <input
                    type="number"
                    value={formData.proposed_yen}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        proposed_yen: e.target.value,
                      })
                    }
                    disabled={isSubmitting}
                    placeholder="0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
                    Justification (min. 50 chars)
                  </label>
                  <textarea
                    value={formData.justification}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        justification: e.target.value,
                      })
                    }
                    disabled={isSubmitting}
                    placeholder="Explain the basis for this reserve…"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                    rows={3}
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    {formData.justification.length} / 50 characters
                  </p>
                </div>

                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowProposeForm(false)}
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-400 disabled:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleProposeReserve}
                    disabled={
                      !formData.proposed_yen ||
                      formData.justification.length < 50 ||
                      isSubmitting
                    }
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {isSubmitting ? '⏳ Proposing…' : '✓ Propose'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reserves list */}
        {isLoading ? (
          <p className="text-sm text-gray-500 text-center py-4">
            Loading reserves…
          </p>
        ) : reserves.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            No reserves proposed
          </p>
        ) : (
          <div className="space-y-3">
            {reserves.map((reserve) => {
              const proposedDate = new Date(
                reserve.proposed_at
              ).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });

              const statusColor =
                reserve.approval_status === 'approved'
                  ? 'bg-green-50 border-green-200'
                  : reserve.approval_status === 'rejected'
                    ? 'bg-red-50 border-red-200'
                    : 'bg-yellow-50 border-yellow-200';

              const statusIcon =
                reserve.approval_status === 'approved'
                  ? '✅'
                  : reserve.approval_status === 'rejected'
                    ? '❌'
                    : '⏳';

              return (
                <div
                  key={reserve.id}
                  className={`p-4 rounded-lg border ${statusColor}`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {RESERVE_CATEGORY_CONFIG[reserve.category].label}
                      </p>
                      <p className="text-xs text-gray-600 mt-1">
                        Proposed {proposedDate}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{statusIcon}</span>
                      <Badge
                        variant={
                          reserve.approval_status === 'approved'
                            ? 'success'
                            : reserve.approval_status === 'rejected'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {reserve.approval_status.charAt(0).toUpperCase() +
                          reserve.approval_status.slice(1)}
                      </Badge>
                    </div>
                  </div>

                  <p className="text-lg font-bold text-gray-900 mb-2">
                    {formatYen(parseInt(reserve.proposed_yen, 10))}
                  </p>

                  <p className="text-sm text-gray-700 mb-2">
                    {reserve.justification}
                  </p>

                  {reserve.reason_for_rejection && (
                    <p className="text-sm text-red-700 mb-2">
                      <span className="font-medium">Rejection reason:</span>{' '}
                      {reserve.reason_for_rejection}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
};

/**
 * ClaimDetail component — displays the full detail view of a single claim.
 * Includes claim information, timeline, notes, evidence, witness statements, and reserves.
 * @returns Rendered claim detail page
 */
export const ClaimDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentUser: user } = useAuth();

  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [notes, setNotes] = useState<ClaimNote[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [statements, setStatements] = useState<WitnessStatement[]>([]);
  const [reserves, setReserves] = useState<Reserve[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch claim details from the API.
   */
  useEffect(() => {
    const fetchClaimDetail = async () => {
      if (!id) return;

      setIsLoading(true);
      setError(null);

      try {
        const token = localStorage.getItem('access_token');
        if (!token) throw new Error('No authentication token');

        const response = await fetch(`/api/claims/${id}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch claim: ${response.statusText}`);
        }

        const data = await response.json();
        setClaim(data);
        setNotes(data.notes || []);
        setEvidence(data.evidence || []);
        setStatements(data.witness_statements || []);
        setReserves(data.reserves || []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load claim details'
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchClaimDetail();
  }, [id]);

  /**
   * Handle adding a note to the claim.
   */
  const handleAddNote = async (body: string) => {
    if (!id) return;

    try {
      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('No authentication token');

      const response = await fetch(`/api/claims/${id}/notes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });

      if (!response.ok) {
        throw new Error('Failed to add note');
      }

      const newNote = await response.json();
      setNotes([...notes, newNote]);
    } catch (err) {
      console.error('Error adding note:', err);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <p className="text-gray-500">Loading claim details…</p>
        </div>
      </Layout>
    );
  }

  if (error || !claim) {
    return (
      <Layout>
        <div className="space-y-6">
          <PageHeader
            title="Claim Detail"
            icon="📋"
            action={
              <button
                onClick={() => navigate('/claims')}
                className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-400 transition-colors"
              >
                ← Back to Queue
              </button>
            }
          />
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700 font-medium">
              ⚠️ {error || 'Claim not found'}
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  const canAddNote =
    user?.role === 'adjuster' || user?.role === 'manager';
  const canAddEvidence = user?.role === 'adjuster';
  const canAddStatement = user?.role === 'adjuster';
  const canProposeReserve = user?.role === 'adjuster';

  return (
    <Layout>
      <div className="space-y-6">
        {/* Page header */}
        <PageHeader
          title={`Claim ${claim.id.substring(0, 8)}`}
          description={`Policy ${claim.policy_number}`}
          icon="📋"
          action={
            <button
              onClick={() => navigate('/claims')}
              className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-400 transition-colors"
            >
              ← Back to Queue
            </button>
          }
        />

        {/* Claim information */}
        <ClaimInfoSection claim={claim} />

        {/* Reporter information */}
        <ReporterInfoSection claim={claim} />

        {/* Notes section */}
        <NotesSection
          claimId={claim.id}
          notes={notes}
          isLoading={false}
          onAddNote={handleAddNote}
          canAddNote={canAddNote}
        />

        {/* Evidence section */}
        <EvidenceSection
          claimId={claim.id}
          evidence={evidence}
          isLoading={false}
          canAddEvidence={canAddEvidence}
        />

        {/* Witness statements section */}
        <WitnessStatementsSection
          claimId={claim.id}
          statements={statements}
          isLoading={false}
          canAddStatement={canAddStatement}
        />

        {/* Reserves section */}
        <ReservesSection
          claimId={claim.id}
          reserves={reserves}
          isLoading={false}
          canProposeReserve={canProposeReserve}
        />
      </div>
    </Layout>
  );
};

export default ClaimDetail;
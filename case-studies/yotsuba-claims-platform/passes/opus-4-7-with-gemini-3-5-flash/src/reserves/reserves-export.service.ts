import { Injectable } from '@nestjs/common';
import { ReservesJfsaService } from './reserves-jfsa.service';

@Injectable()
export class ReservesExportService {
  constructor(private readonly reservesService: ReservesJfsaService) {}

  async exportToCsv(status?: 'PROPOSED' | 'APPROVED' | 'REJECTED'): Promise<string> {
    let reserves = await this.reservesService.getAll();
    if (status) {
      reserves = reserves.filter(r => r.status === status);
    }

    const headers = [
      'ID',
      'Claim ID',
      'Amount',
      'Currency',
      'Justification',
      'Proposed By',
      'Proposed At',
      'Status',
      'Approved By',
      'Approved At',
      'Rejected By',
      'Rejected At',
      'Rejection Reason',
      'JFSA Compliance Verified'
    ];

    const rows = [headers.join(',')];

    for (const r of reserves) {
      const values = [
        r.id,
        r.claimId,
        r.amount.toString(),
        r.currency,
        r.justification || '',
        r.proposedBy,
        r.proposedAt ? r.proposedAt.toISOString() : '',
        r.status,
        r.approvedBy || '',
        r.approvedAt ? r.approvedAt.toISOString() : '',
        r.rejectedBy || '',
        r.rejectedAt ? r.rejectedAt.toISOString() : '',
        r.rejectionReason || '',
        r.jfsaComplianceVerified ? 'TRUE' : 'FALSE'
      ];

      const escapedRow = values.map(val => {
        const clean = val.replace(/"/g, '""');
        if (clean.includes(',') || clean.includes('"') || clean.includes('\n') || clean.includes('\r')) {
          return `"${clean}"`;
        }
        return clean;
      });

      rows.push(escapedRow.join(','));
    }

    return rows.join('\n');
  }

  async exportToJson(status?: 'PROPOSED' | 'APPROVED' | 'REJECTED'): Promise<string> {
    let reserves = await this.reservesService.getAll();
    if (status) {
      reserves = reserves.filter(r => r.status === status);
    }
    return JSON.stringify(reserves, null, 2);
  }
}
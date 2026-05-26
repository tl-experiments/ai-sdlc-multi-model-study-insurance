import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';

export enum ClaimChannelType {
  WEB = 'WEB',
  MOBILE = 'MOBILE',
  EMAIL = 'EMAIL',
  API = 'API',
  PARTNER = 'PARTNER',
}

export interface ChannelConfig {
  allowedFileTypes: string[];
  maxFileSizeMb: number;
  requiresMfa: boolean;
  autoApproveThreshold?: number;
}

export interface ChannelMessage {
  id: string;
  senderId: string;
  senderRole: 'CLAIMANT' | 'ADJUSTER' | 'WITNESS' | 'SYSTEM';
  content: string;
  createdAt: Date;
  attachments?: Array<{ type: string; url: string }>;
}

export interface ClaimChannelSession {
  claimId: string;
  channelType: ClaimChannelType;
  participants: Set<string>;
  messages: ChannelMessage[];
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ClaimsChannelService {
  private readonly channelConfigs = new Map<ClaimChannelType, ChannelConfig>([
    [
      ClaimChannelType.WEB,
      { allowedFileTypes: ['pdf', 'jpg', 'png'], maxFileSizeMb: 10, requiresMfa: false },
    ],
    [
      ClaimChannelType.MOBILE,
      { allowedFileTypes: ['jpg', 'png', 'heic'], maxFileSizeMb: 15, requiresMfa: true },
    ],
    [
      ClaimChannelType.EMAIL,
      { allowedFileTypes: ['pdf', 'jpg', 'png', 'doc', 'docx'], maxFileSizeMb: 25, requiresMfa: false },
    ],
    [
      ClaimChannelType.API,
      { allowedFileTypes: ['pdf', 'json', 'xml'], maxFileSizeMb: 50, requiresMfa: true },
    ],
    [
      ClaimChannelType.PARTNER,
      { allowedFileTypes: ['pdf', 'zip'], maxFileSizeMb: 100, requiresMfa: true },
    ],
  ]);

  private readonly activeSessions = new Map<string, ClaimChannelSession>();

  getChannelConfig(channelType: ClaimChannelType): ChannelConfig {
    const config = this.channelConfigs.get(channelType);
    if (!config) {
      throw new NotFoundException(`Configuration for channel type "${channelType}" not found`);
    }
    return config;
  }

  updateChannelConfig(channelType: ClaimChannelType, updates: Partial<ChannelConfig>): ChannelConfig {
    const existing = this.getChannelConfig(channelType);
    const updated = { ...existing, ...updates };
    this.channelConfigs.set(channelType, updated);
    return updated;
  }

  initializeSession(claimId: string, channelType: ClaimChannelType, metadata: Record<string, any> = {}): ClaimChannelSession {
    if (!claimId) {
      throw new BadRequestException('Claim ID is required to initialize a channel session');
    }
    if (!Object.values(ClaimChannelType).includes(channelType)) {
      throw new BadRequestException(`Invalid channel type: ${channelType}`);
    }
    if (this.activeSessions.has(claimId)) {
      throw new BadRequestException(`Session already exists for claim: ${claimId}`);
    }

    const session: ClaimChannelSession = {
      claimId,
      channelType,
      participants: new Set<string>(),
      messages: [],
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.activeSessions.set(claimId, session);
    return session;
  }

  getSession(claimId: string): ClaimChannelSession {
    const session = this.activeSessions.get(claimId);
    if (!session) {
      throw new NotFoundException(`No active channel session found for claim: ${claimId}`);
    }
    return session;
  }

  addParticipant(claimId: string, participantId: string): void {
    const session = this.getSession(claimId);
    if (!participantId) {
      throw new BadRequestException('Participant ID is required');
    }
    session.participants.add(participantId);
    session.updatedAt = new Date();
  }

  removeParticipant(claimId: string, participantId: string): void {
    const session = this.getSession(claimId);
    if (!session.participants.has(participantId)) {
      throw new NotFoundException(`Participant "${participantId}" not found in session for claim: ${claimId}`);
    }
    session.participants.delete(participantId);
    session.updatedAt = new Date();
  }

  sendMessage(
    claimId: string,
    senderId: string,
    senderRole: 'CLAIMANT' | 'ADJUSTER' | 'WITNESS' | 'SYSTEM',
    content: string,
    attachments?: Array<{ type: string; url: string }>
  ): ChannelMessage {
    const session = this.getSession(claimId);

    if (!senderId) {
      throw new BadRequestException('Sender ID is required');
    }
    if (!content || content.trim() === '') {
      throw new BadRequestException('Message content cannot be empty');
    }

    if (senderRole !== 'SYSTEM' && !session.participants.has(senderId)) {
      throw new BadRequestException(`Sender "${senderId}" is not a registered participant in this channel`);
    }

    if (attachments && attachments.length > 0) {
      const config = this.getChannelConfig(session.channelType);
      for (const attachment of attachments) {
        const extension = attachment.url.split('.').pop()?.toLowerCase() || '';
        if (!config.allowedFileTypes.includes(extension)) {
          throw new BadRequestException(
            `File type ".${extension}" is not allowed for channel type "${session.channelType}". Allowed types: ${config.allowedFileTypes.join(', ')}`
          );
        } 
      }
    }

    const message: ChannelMessage = {
      id: `msg_${Math.random().toString(36).substr(2, 9)}`,
      senderId,
      senderRole,
      content,
      createdAt: new Date(),
      attachments,
    };

    session.messages.push(message);
    session.updatedAt = new Date();
    return message;
  }

  getMessages(claimId: string): ChannelMessage[] {
    return this.getSession(claimId).messages;
  }

  closeSession(claimId: string): void {
    if (!this.activeSessions.has(claimId)) {
      throw new NotFoundException(`No active channel session found for claim: ${claimId}`);
    }
    this.activeSessions.delete(claimId);
  }
}
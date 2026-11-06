import { Injectable, Logger } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';

@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);

  isConfigured(): boolean {
    const url = (process.env.LIVEKIT_URL || '').trim();
    const key = (process.env.LIVEKIT_API_KEY || '').trim();
    const secret = (process.env.LIVEKIT_API_SECRET || '').trim();
    return Boolean(url && key && secret);
  }

  getPublicUrl(): string {
    return (process.env.LIVEKIT_URL || 'ws://localhost:7880').trim();
  }

  /**
   * Token for student browser: publish mic, subscribe counselor A/V.
   */
  async createParticipantToken(opts: {
    roomName: string;
    identity: string;
    name?: string;
  }): Promise<{ token: string; url: string; roomName: string }> {
    const apiKey = (process.env.LIVEKIT_API_KEY || 'devkey').trim();
    const apiSecret = (process.env.LIVEKIT_API_SECRET || 'secret_dev_livekit_change_me').trim();
    const url = this.getPublicUrl();

    const at = new AccessToken(apiKey, apiSecret, {
      identity: opts.identity,
      name: opts.name || opts.identity,
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: opts.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    this.logger.log(`LiveKit token issued room=${opts.roomName} identity=${opts.identity}`);
    return { token, url, roomName: opts.roomName };
  }
}

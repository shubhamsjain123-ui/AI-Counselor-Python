import { Module } from '@nestjs/common';
import { AiCounselorController } from './ai-counselor.controller';
import { AiCounselorService } from './ai-counselor.service';
import { AiCounselorGateway } from './ai-counselor.gateway';
import { LipSyncStreamService } from './lip-sync-stream.service';
import { LivekitService } from '../livekit/livekit.service';
import { LivekitBridgeService } from '../livekit/livekit-bridge.service';

@Module({
  controllers: [AiCounselorController],
  providers: [
    AiCounselorService,
    AiCounselorGateway,
    LipSyncStreamService,
    LivekitService,
    LivekitBridgeService,
  ],
  exports: [
    AiCounselorService,
    AiCounselorGateway,
    LipSyncStreamService,
    LivekitService,
    LivekitBridgeService,
  ],
})
export class AiCounselorModule {}

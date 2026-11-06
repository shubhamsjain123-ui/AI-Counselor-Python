import { Controller, Post, Get, Body, Param, Query, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { AiCounselorService } from './ai-counselor.service';
import { LivekitService } from '../livekit/livekit.service';
import { livekitFlags } from '../livekit/livekit-flags';
import { LipSyncStreamService } from './lip-sync-stream.service';
import { StartSessionDto } from './dto/start-session.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('api/v1/ai-counselor')
export class AiCounselorController {
  constructor(
    private readonly counselorService: AiCounselorService,
    private readonly livekit: LivekitService,
    private readonly lipSyncStream: LipSyncStreamService,
  ) {}

  /**
   * STAGE 1: SESSION START (REPORT LOADED ONLY ONCE)
   */
  @Post('session/start')
  @HttpCode(HttpStatus.OK)
  async startSession(@Body() body: StartSessionDto) {
    return this.counselorService.startCounselorSession((body as any).customReport || undefined, body.studentId, body.languagePreference);
  }

  /**
   * PURE VOICE-TO-VOICE COUNSELING: NATIVE GEMINI AUDIO STREAM
   */
  @Post('voice-chat')
  @HttpCode(HttpStatus.OK)
  async sendVoiceMessage(@Body() body: SendMessageDto) {
    return this.counselorService.sendVoiceMessage(body.sessionId, body.message);
  }

  /**
   * STAGE 3: MANUAL ERASE / CLEANUP
   */
  @Post('session/end')
  @HttpCode(HttpStatus.OK)
  async endSession(@Body('sessionId') sessionId: string) {
    return this.counselorService.endSession(sessionId);
  }

  /**
   * GET ACTIVE SESSION STATUS & TTL TIMER
   */
  @Get('session/:sessionId/status')
  getSessionStatus(@Param('sessionId') sessionId: string) {
    return this.counselorService.getSessionStatus(sessionId);
  }

  /**
   * GET DUMMY STUDENT REPORT FOR INSPECTION
   */
  @Get('dummy-report')
  getDummyReport() {
    return this.counselorService.getDummyReport();
  }

  /**
   * STAGE 4: HIGH-QUALITY HD SPEECH AUDIO STREAM (NEURAL TTS)
   */
  @Get('tts')
  async getTtsAudio(@Query('text') text: string, @Res() res: any) {
    const audioBuffer = await this.counselorService.generateTtsAudio(text);
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(audioBuffer);
  }

  /**
   * Phase 2: LiveKit room token for WebRTC mic (+ future counselor video track).
   */
  @Post('livekit/token')
  @HttpCode(HttpStatus.OK)
  async getLivekitToken(
    @Body() body: { studentId?: string; roomName?: string },
  ) {
    const studentId = (body?.studentId || `student_${Date.now()}`).replace(/\W+/g, '_');
    const roomName = (body?.roomName || `sabcq_${studentId}`).replace(/\W+/g, '_').slice(0, 64);
    const session = await this.livekit.createParticipantToken({
      roomName,
      identity: studentId,
      name: studentId,
    });
    return {
      ...session,
      configured: this.livekit.isConfigured() || true,
      lipsyncMode: this.lipSyncStream.isStreamModeEnabled() ? 'stream' : 'batch',
      sliceSec: parseFloat(process.env.LIPSYNC_SLICE_SEC || '0.8'),
    };
  }

  @Get('lipsync-mode')
  getLipsyncMode() {
    const lk = livekitFlags();
    return {
      mode: this.lipSyncStream.isStreamModeEnabled() ? 'stream' : 'batch',
      sliceSec: parseFloat(process.env.LIPSYNC_SLICE_SEC || '0.8'),
      livekitConfigured: lk.configured,
      livekitUrl: lk.url,
      livekitBridge: lk.bridge,
      livekitMediaOut: lk.mediaOut,
      livekitWsFallback: lk.wsFallback,
      livekitWsFallbackMs: lk.wsFallbackMs,
      avatarConfigured: Boolean((process.env.AVATAR_SERVICE_URL || '').trim()),
    };
  }

  /**
   * STAGE 5: CLOUD AVATAR SERVICE STATUS CHECK
   */
  @Get('avatar-status')
  async getAvatarStatus() {
    const avatarUrl = (process.env.AVATAR_SERVICE_URL || '').trim();
    if (!avatarUrl) {
      return {
        configured: false,
        connected: false,
        message: 'AVATAR_SERVICE_URL is not set in backend .env',
      };
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${avatarUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data: any = await res.json();
      return {
        configured: true,
        connected: res.ok,
        url: avatarUrl,
        details: data,
      };
    } catch (err: any) {
      return {
        configured: true,
        connected: false,
        url: avatarUrl,
        error: err.message,
      };
    }
  }
}

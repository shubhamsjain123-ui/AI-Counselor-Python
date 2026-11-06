'use client';

import { useCallback, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  setLogLevel,
  LogLevel,
  type LocalAudioTrack,
  type RemoteTrack,
  type RemoteParticipant,
} from 'livekit-client';
import { AI_COUNSELOR_API_BASE } from '@/lib/backend';

// Quiet noisy race warnings (DATA_TRACK_LOSSY / participant not present) in console UI.
try {
  setLogLevel(LogLevel.warn);
} catch (_) {}

export type LiveKitConnectResult =
  | { ok: true; roomName: string; url: string; mediaStream: MediaStream }
  | { ok: false; error?: string };

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Phase 3a–3c: LiveKit mic + counselor A/V subscribe, mute, barge-in stop, reconnect.
 */
export function useLiveKitMic(opts?: {
  counselorVideoRef?: React.RefObject<HTMLVideoElement | null>;
  counselorAudioRef?: React.RefObject<HTMLAudioElement | null>;
  onCounselorMedia?: (active: boolean) => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Phase 3c: after auto-reconnect, Nest bridge must re-join the room */
  onReconnected?: (roomName: string) => void;
}) {
  const roomRef = useRef<Room | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const studentIdRef = useRef<string>('web');
  const intentionalDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [counselorMediaActive, setCounselorMediaActive] = useState(false);
  const [micMuted, setMicMutedState] = useState(false);

  const detachCounselorMedia = useCallback(() => {
    const v = optsRef.current?.counselorVideoRef?.current;
    const a = optsRef.current?.counselorAudioRef?.current;
    if (v) {
      try {
        v.srcObject = null;
        v.pause();
      } catch (_) {}
    }
    if (a) {
      try {
        a.srcObject = null;
        a.pause();
      } catch (_) {}
    }
    setCounselorMediaActive(false);
    optsRef.current?.onCounselorMedia?.(false);
  }, []);

  /** Phase 3c barge-in: stop remote counselor A/V playback immediately. */
  const stopCounselorPlayback = useCallback(() => {
    const v = optsRef.current?.counselorVideoRef?.current;
    const a = optsRef.current?.counselorAudioRef?.current;
    if (v) {
      try {
        v.pause();
        if (v.srcObject) {
          /* keep srcObject for track; just pause */
        }
      } catch (_) {}
    }
    if (a) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch (_) {}
    }
    setCounselorMediaActive(false);
    optsRef.current?.onCounselorMedia?.(false);
  }, []);

  const attachRemoteTrack = useCallback((track: RemoteTrack, participant: RemoteParticipant) => {
    try {
      if (!participant?.identity?.startsWith('bridge_')) return;

      if (track.kind === Track.Kind.Video) {
        const el = optsRef.current?.counselorVideoRef?.current;
        if (!el) return;
        track.attach(el);
        el.muted = true;
        void el.play().catch(() => {});
        setCounselorMediaActive(true);
        optsRef.current?.onCounselorMedia?.(true);
        console.log('[LiveKit] counselor video attached');
      } else if (track.kind === Track.Kind.Audio) {
        const el = optsRef.current?.counselorAudioRef?.current;
        if (!el) return;
        track.attach(el);
        void el.play().catch(() => {});
        setCounselorMediaActive(true);
        optsRef.current?.onCounselorMedia?.(true);
        console.log('[LiveKit] counselor audio attached');
      }
    } catch (err) {
      // Stale participant SID races — non-fatal; WS progressive covers lips.
      console.warn('[LiveKit] track attach skipped (stale participant race)', err);
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(async () => {
    intentionalDisconnectRef.current = true;
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    detachCounselorMedia();
    const track = micTrackRef.current;
    micTrackRef.current = null;
    mediaStreamRef.current = null;
    if (track) {
      try {
        track.stop();
      } catch (_) {}
    }
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      try {
        await room.disconnect();
      } catch (_) {}
    }
    setConnected(false);
    setRoomName(null);
    setMicMutedState(false);
    optsRef.current?.onConnectionChange?.(false);
  }, [detachCounselorMedia, clearReconnectTimer]);

  const connectInternal = useCallback(
    async (studentId: string, isReconnect: boolean): Promise<LiveKitConnectResult> => {
      try {
        setError(null);
        intentionalDisconnectRef.current = false;

        // Tear previous room without marking intentional (reconnect path).
        const prevTrack = micTrackRef.current;
        micTrackRef.current = null;
        if (prevTrack) {
          try {
            prevTrack.stop();
          } catch (_) {}
        }
        const prevRoom = roomRef.current;
        roomRef.current = null;
        if (prevRoom) {
          try {
            await prevRoom.disconnect();
          } catch (_) {}
        }
        detachCounselorMedia();

        const res = await fetch(`${AI_COUNSELOR_API_BASE}/livekit/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ studentId }),
        });
        if (!res.ok) throw new Error(`token HTTP ${res.status}`);
        const data = await res.json();
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        room.on(RoomEvent.Disconnected, () => {
          setConnected(false);
          optsRef.current?.onConnectionChange?.(false);
          detachCounselorMedia();
          if (intentionalDisconnectRef.current) return;

          const attempt = reconnectAttemptsRef.current + 1;
          if (attempt > MAX_RECONNECT_ATTEMPTS) {
            console.warn('[Phase3c] LiveKit reconnect gave up — WS fallback path remains');
            setError('LiveKit disconnected');
            return;
          }
          reconnectAttemptsRef.current = attempt;
          const delay = Math.min(8000, 500 * 2 ** (attempt - 1));
          console.warn(`[Phase3c] LiveKit reconnect attempt ${attempt} in ${delay}ms`);
          clearReconnectTimer();
          reconnectTimerRef.current = setTimeout(() => {
            void connectInternal(studentIdRef.current, true).then((r) => {
              if (r.ok) {
                reconnectAttemptsRef.current = 0;
                console.log('[Phase3c] LiveKit reconnected');
              }
            });
          }, delay);
        });

        const attachParticipantTracks = (participant: RemoteParticipant) => {
          for (const pub of participant.trackPublications.values()) {
            if (pub.track) attachRemoteTrack(pub.track as RemoteTrack, participant);
          }
        };

        room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          attachRemoteTrack(track, participant);
        });

        room.on(RoomEvent.ParticipantConnected, (participant) => {
          console.log('[LiveKit] participant connected', participant.identity);
          attachParticipantTracks(participant);
        });

        room.on(RoomEvent.TrackPublished, (pub, participant) => {
          // Ensure we subscribe when bridge publishes after we already joined.
          if (participant.identity?.startsWith('bridge_') && !pub.isSubscribed) {
            try {
              pub.setSubscribed(true);
            } catch (_) {}
          }
        });

        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          try {
            track.detach();
          } catch (_) {}
        });

        await room.connect(data.url, data.token);

        for (const p of room.remoteParticipants.values()) {
          attachParticipantTracks(p);
        }

        const mic = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        micTrackRef.current = mic;
        await room.localParticipant.publishTrack(mic, {
          name: 'student-mic',
          source: Track.Source.Microphone,
        });

        const mediaStream =
          mic.mediaStream || new MediaStream([mic.mediaStreamTrack]);
        mediaStreamRef.current = mediaStream;

        setConnected(true);
        setRoomName(data.roomName);
        setMicMutedState(false);
        optsRef.current?.onConnectionChange?.(true);
        console.log(
          isReconnect ? '[Phase3c] LiveKit reconnected' : '[LiveKit] connected',
          data.roomName,
          data.url,
        );
        if (isReconnect) {
          optsRef.current?.onReconnected?.(data.roomName);
        }
        return {
          ok: true,
          roomName: data.roomName,
          url: data.url,
          mediaStream,
        };
      } catch (err: any) {
        console.warn('[LiveKit] connect failed — using legacy WS mic:', err?.message || err);
        setError(err?.message || 'LiveKit unavailable');
        setConnected(false);
        setRoomName(null);
        optsRef.current?.onConnectionChange?.(false);
        return { ok: false, error: err?.message || 'LiveKit unavailable' };
      }
    },
    [attachRemoteTrack, detachCounselorMedia, clearReconnectTimer],
  );

  const connect = useCallback(
    async (studentId?: string): Promise<LiveKitConnectResult> => {
      studentIdRef.current = studentId || `web_${Date.now()}`;
      reconnectAttemptsRef.current = 0;
      clearReconnectTimer();
      return connectInternal(studentIdRef.current, false);
    },
    [connectInternal, clearReconnectTimer],
  );

  const setMicMuted = useCallback(async (muted: boolean) => {
    const track = micTrackRef.current;
    if (track) {
      try {
        if (muted) await track.mute();
        else await track.unmute();
      } catch (err) {
        console.warn('[Phase3c] mic mute failed', err);
      }
    }
    setMicMutedState(muted);
  }, []);

  return {
    connect,
    disconnect,
    connected,
    error,
    roomName,
    counselorMediaActive,
    micMuted,
    setMicMuted,
    stopCounselorPlayback,
    getMediaStream: () => mediaStreamRef.current,
  };
}

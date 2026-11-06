'use client';

import { useCallback, useRef } from 'react';

export type StreamSegment = {
  seq: number;
  blobUrl: string;
  durationHintSec?: number;
};

export type BeginTurnOpts = {
  /**
   * Wait until endTurnProduce (stream_turn_flushed) before first play.
   * Required when MuseTalk is slower than realtime (Colab ~15s per 2s clip).
   */
  holdUntilFlush?: boolean;
};

/**
 * Progressive MuseTalk clips.
 * Default: holdUntilFlush — queue every clip, play only after producer finishes
 * so Colab lag never causes "1–2 words then freeze" underruns.
 */
export function useProgressiveLipSync(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onPlayingChange?: (playing: boolean) => void;
  onQueueEmpty?: () => void;
  onBuffering?: (buffering: boolean) => void;
  minBufferSegments?: number;
  rebufferSegments?: number;
}) {
  const queueRef = useRef<StreamSegment[]>([]);
  const playingRef = useRef(false);
  const underrunRef = useRef(false);
  const primingRef = useRef(false);
  const holdUntilFlushRef = useRef(true);
  const generationRef = useRef(0);
  const turnOpenRef = useRef(false);
  const minBufferRef = useRef(Math.max(2, opts.minBufferSegments ?? 6));
  const rebufferRef = useRef(
    Math.max(2, opts.rebufferSegments ?? opts.minBufferSegments ?? 4),
  );

  const setBufferingUi = useCallback(
    (v: boolean) => {
      primingRef.current = v;
      opts.onBuffering?.(v);
    },
    [opts],
  );

  const freezeLastFrame = useCallback(() => {
    const vid = opts.videoRef.current;
    if (!vid) return;
    try {
      vid.pause();
    } catch (_) {}
  }, [opts.videoRef]);

  const playNext = useCallback(() => {
    const vid = opts.videoRef.current;
    if (!vid) return;

    const next = queueRef.current.shift();
    if (!next) {
      if (turnOpenRef.current) {
        playingRef.current = false;
        underrunRef.current = true;
        freezeLastFrame();
        setBufferingUi(true);
        console.warn(
          `[ProgressiveLipSync] underrun — freeze, need ${rebufferRef.current} clips`,
        );
        return;
      }
      playingRef.current = false;
      underrunRef.current = false;
      setBufferingUi(false);
      opts.onPlayingChange?.(false);
      opts.onQueueEmpty?.();
      return;
    }

    underrunRef.current = false;
    setBufferingUi(false);
    playingRef.current = true;
    opts.onPlayingChange?.(true);

    try {
      const prevSrc = vid.src;
      vid.src = next.blobUrl;
      vid.currentTime = 0;
      vid.muted = false;
      if (prevSrc && prevSrc.startsWith('blob:') && prevSrc !== next.blobUrl) {
        try {
          URL.revokeObjectURL(prevSrc);
        } catch (_) {}
      }

      const gen = generationRef.current;
      let advanced = false;
      const advance = () => {
        if (advanced || generationRef.current !== gen) return;
        advanced = true;
        playNext();
      };

      vid.ontimeupdate = () => {
        if (generationRef.current !== gen) return;
        if (
          Number.isFinite(vid.duration) &&
          vid.duration > 0.25 &&
          vid.currentTime >= vid.duration - 0.06
        ) {
          advance();
        }
      };
      vid.onended = () => advance();
      void vid.play().catch((err) => {
        console.warn('[ProgressiveLipSync] play blocked, trying muted', err);
        vid.muted = true;
        void vid.play().catch(console.warn);
      });
    } catch (err) {
      console.warn('[ProgressiveLipSync] playNext error', err);
      playNext();
    }
  }, [opts, setBufferingUi, freezeLastFrame]);

  const tryStartOrResume = useCallback(() => {
    if (playingRef.current) return;

    const q = queueRef.current.length;

    // Holding for full turn — do not start until endTurnProduce.
    if (holdUntilFlushRef.current && turnOpenRef.current) {
      if (q > 0) setBufferingUi(true);
      return;
    }

    if (underrunRef.current && turnOpenRef.current) {
      if (q < rebufferRef.current) {
        setBufferingUi(true);
        return;
      }
      console.log(`[ProgressiveLipSync] rebuffered queue=${q} — resume`);
      playNext();
      return;
    }

    const need = minBufferRef.current;
    const ready = q >= need || (!turnOpenRef.current && q > 0);
    if (!ready) {
      if (q > 0) setBufferingUi(true);
      return;
    }
    console.log(`[ProgressiveLipSync] starting queue=${q} minBuffer=${need}`);
    playNext();
  }, [playNext, setBufferingUi]);

  const beginTurn = useCallback(
    (beginOpts?: BeginTurnOpts) => {
      turnOpenRef.current = true;
      underrunRef.current = false;
      holdUntilFlushRef.current = beginOpts?.holdUntilFlush !== false; // default true
      setBufferingUi(false);
      console.log(
        `[ProgressiveLipSync] beginTurn holdUntilFlush=${holdUntilFlushRef.current}`,
      );
    },
    [setBufferingUi],
  );

  const endTurnProduce = useCallback(() => {
    turnOpenRef.current = false;
    const q = queueRef.current.length;
    console.log(
      `[ProgressiveLipSync] producer done queue=${q} — starting smooth drain`,
    );
    if (!playingRef.current && q > 0) {
      underrunRef.current = false;
      setBufferingUi(false);
      playNext();
    } else if (!playingRef.current && q === 0) {
      underrunRef.current = false;
      setBufferingUi(false);
      opts.onPlayingChange?.(false);
      opts.onQueueEmpty?.();
    }
  }, [playNext, opts, setBufferingUi]);

  const enqueueSegment = useCallback(
    (videoBase64: string, mimeType = 'video/mp4', seq = 0, durationHintSec?: number) => {
      try {
        const binary = atob(videoBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);
        queueRef.current.push({ seq, blobUrl, durationHintSec });
        queueRef.current.sort((a, b) => a.seq - b.seq);

        const q = queueRef.current.length;
        if (q <= 3 || q % 5 === 0) {
          console.log(
            `[ProgressiveLipSync] queued seq=${seq} queue=${q} hold=${holdUntilFlushRef.current} playing=${playingRef.current}`,
          );
        }

        if (playingRef.current) return;
        tryStartOrResume();
      } catch (err) {
        console.warn('[ProgressiveLipSync] enqueue failed', err);
      }
    },
    [tryStartOrResume],
  );

  const clearQueue = useCallback(() => {
    generationRef.current += 1;
    turnOpenRef.current = false;
    underrunRef.current = false;
    holdUntilFlushRef.current = true;
    setBufferingUi(false);
    queueRef.current.forEach((s) => {
      try {
        URL.revokeObjectURL(s.blobUrl);
      } catch (_) {}
    });
    queueRef.current = [];
    playingRef.current = false;
    const vid = opts.videoRef.current;
    if (vid) {
      try {
        vid.onended = null;
        vid.ontimeupdate = null;
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
      } catch (_) {}
    }
    opts.onPlayingChange?.(false);
  }, [opts, setBufferingUi]);

  return {
    enqueueSegment,
    clearQueue,
    beginTurn,
    endTurnProduce,
    isPlaying: () => playingRef.current,
    isBuffering: () => primingRef.current || underrunRef.current,
  };
}

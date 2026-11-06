/** Phase 3c: single place for LiveKit feature flags (local self-host, no cloud required). */

function flagOn(name: string, defaultOn = true): boolean {
  const raw = (process.env[name] || (defaultOn ? 'true' : 'false')).trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return defaultOn;
}

export function livekitFlags() {
  const configured = Boolean(
    (process.env.LIVEKIT_URL || '').trim() &&
      (process.env.LIVEKIT_API_KEY || '').trim() &&
      (process.env.LIVEKIT_API_SECRET || '').trim(),
  );
  const bridge = configured && flagOn('LIVEKIT_BRIDGE_ENABLED', true);
  // Default OFF: MuseTalk stream = discrete MP4 clips; LiveKit republish per clip = gaps/shhhh.
  // Mic bridge still works. Lips use WS progressive until continuous encoder exists.
  const mediaOut = bridge && flagOn('LIVEKIT_MEDIA_OUT', false);
  /** When media-out is on, still allow delayed WS progressive fallback if LiveKit A/V never attaches. */
  const wsFallback = flagOn('LIVEKIT_WS_FALLBACK', true);
  // Short visual grace: if LiveKit lips aren't attached soon, play stashed WS clips
  // (still prefer LiveKit when attach succeeds). Avoid long black screen.
  const wsFallbackMs = Math.min(
    20000,
    Math.max(3000, parseInt(process.env.LIVEKIT_WS_FALLBACK_MS || '5000', 10) || 5000),
  );
  return {
    configured,
    bridge,
    mediaOut,
    wsFallback,
    wsFallbackMs,
    url: (process.env.LIVEKIT_URL || 'ws://localhost:7880').trim(),
  };
}

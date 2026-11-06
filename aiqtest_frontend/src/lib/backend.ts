export const BACKEND_PORT = process.env.NEXT_PUBLIC_BACKEND_PORT || '3002';

const rawHttpUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3002').trim();
export const BACKEND_HTTP_URL = (
  rawHttpUrl.startsWith('http://') || rawHttpUrl.startsWith('https://')
    ? rawHttpUrl
    : `http://${rawHttpUrl}`
).replace(/\/+$/, '');

const rawWsUrl = (
  process.env.NEXT_PUBLIC_BACKEND_WS_URL || BACKEND_HTTP_URL.replace(/^http/, 'ws')
).trim();
export const BACKEND_WS_URL = (
  rawWsUrl.startsWith('ws://') || rawWsUrl.startsWith('wss://')
    ? rawWsUrl
    : `ws://${rawWsUrl}`
).replace(/\/+$/, '');

export const AI_COUNSELOR_API_BASE = `${BACKEND_HTTP_URL}/api/v1/ai-counselor`;
export const AI_COUNSELOR_WS_URL = `${BACKEND_WS_URL}/ws/live-counselor`;



// Yeastar P-Series "WebSocket Audio Streaming" transport.
//
// The PBX opens a WebSocket to YEASTAR_PATH (default /yeastar-stream) and sends
// the shared secret in an HTTP header during the upgrade. Audio is PCM16 LE
// 8 kHz, base64 in JSON: { callid, channelid, callflow, number, status, audio }.
// We convert PCM16 <-> µ-law at the edge; OpenAI Realtime speaks µ-law natively.
//
// Return audio (from us back to the PBX) is not documented by Yeastar; we mirror
// the inbound envelope and target the caller's channelid.
//
// Yeastar has no playback-finished events, so marks are emulated from the
// amount of audio sent (8 bytes of µ-law = 1 ms). There is no live transfer —
// escalation stays asynchronous (webhook / e-mail / helpdesk).
const { str } = require('../../packages/core/config');
const { startCallSession } = require('../../packages/core/realtime');
const { pcm16ToUlaw, ulawToPcm16, ulawDurationMs } = require('../../packages/core/audio');

// The docs do not name the header that carries the secret; accept the common ones.
const SECRET_HEADERS = ['secret', 'x-auth-token', 'authorization', 'x-api-key'];

function authorize(req) {
  const configured = str('YEASTAR_SECRET');
  if (!configured) return { ok: false, code: 1011, why: 'YEASTAR_SECRET not configured' };
  const got = SECRET_HEADERS.map((h) => req.headers[h]).find((v) => v && v.length) || '';
  const clean = String(got).replace(/^Bearer\s+/i, '').trim();
  return clean === configured ? { ok: true } : { ok: false, code: 1008, why: 'unauthorized' };
}

function createYeastarSession(ws) {
  const cbs = { ready: [], audioIn: [], mark: [], hangup: [] };
  const emit = (k, ...a) => cbs[k].forEach((f) => {
    try { f(...a); } catch (e) { console.error('[YEASTAR] callback error:', e.message); }
  });
  let callId = null;
  let channelId = null;
  let hungUp = false;
  let playUntil = 0;              // estimated wall-clock time when queued audio finishes playing
  const markTimers = new Map();   // timer -> name
  let msgCount = 0;

  const hangupOnce = () => {
    if (hungUp) return;
    hungUp = true;
    for (const t of markTimers.keys()) clearTimeout(t);
    markTimers.clear();
    emit('hangup');
  };

  const session = {
    callId: 'yeastar-pending',
    callerPhone: null,
    didNumber: null,
    canTransfer: false,
    onReady: (f) => cbs.ready.push(f),
    onAudioIn: (f) => cbs.audioIn.push(f),
    onMark: (f) => cbs.mark.push(f),
    onHangup: (f) => cbs.hangup.push(f),
    sendAudio(ulaw) {
      if (!callId || !channelId || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ callid: callId, channelid: channelId, status: 'process', audio: ulawToPcm16(ulaw).toString('base64') }));
      playUntil = Math.max(playUntil, Date.now()) + ulawDurationMs(ulaw);
    },
    sendMark(name) {
      const t = setTimeout(() => { markTimers.delete(t); emit('mark', name); }, Math.max(0, playUntil - Date.now()));
      markTimers.set(t, name);
    },
    clearAudio() {
      // Audio already sent to the PBX cannot be recalled; reset the estimate and
      // fire pending marks now (same semantics as the RTP pacer).
      playUntil = Date.now();
      const names = [...markTimers.entries()];
      markTimers.clear();
      for (const [t, name] of names) { clearTimeout(t); emit('mark', name); }
    },
    escalate: async () => false,
    hangup() { try { ws.close(); } catch (_) {} },
  };

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) {
      console.log('[YEASTAR] non-JSON message, len', data.length);
      return;
    }
    msgCount++;
    if (msgCount <= 3) {
      console.log(`[YEASTAR] msg #${msgCount} keys=${Object.keys(msg).join(',')} status=${msg.status || '-'} callflow=${msg.callflow || '-'}`);
    }

    // First message establishes the call
    if (msg.callid && !callId) {
      callId = String(msg.callid);
      session.callId = `ys-${callId}`;
      session.callerPhone = msg.number || null;
      emit('ready');
    }
    // Lock onto the first channel we see; in a two-party call both legs arrive
    // and forwarding both would double the audio.
    if (!channelId && msg.channelid && msg.status === 'process') channelId = msg.channelid;

    if (msg.status === 'end') {
      console.log(`[YEASTAR] call ${callId} ended by PBX`);
      hangupOnce();
      return;
    }
    if (msg.audio && msg.status === 'process' && msg.channelid === channelId) {
      emit('audioIn', pcm16ToUlaw(Buffer.from(msg.audio, 'base64')));
    }
  });
  ws.on('close', () => hangupOnce());
  ws.on('error', (e) => console.error('[YEASTAR] ws error:', e.message));
  return session;
}

function start({ agent, http }) {
  const path = str('YEASTAR_PATH', '/yeastar-stream');
  http.onWebSocket(path, (ws, req) => {
    const auth = authorize(req);
    if (!auth.ok) {
      console.error('[YEASTAR] refusing connection:', auth.why);
      ws.close(auth.code, auth.why);
      return;
    }
    startCallSession(createYeastarSession(ws), agent);
  });
  console.log(`[YEASTAR] listening for PBX audio streams on ${path}`);
}

module.exports = { start, createYeastarSession, authorize };

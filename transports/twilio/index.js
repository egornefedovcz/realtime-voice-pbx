// Twilio Media Streams transport (handy for testing without your own PBX).
//
// Point the Twilio number's voice webhook to POST https://<host>/incoming-call.
// TwiML connects the call to wss://<host>/media-stream. No live transfer here —
// escalation stays asynchronous.
const { startCallSession } = require('../../packages/core/realtime');

let seq = 0;

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function createTwilioSession(ws) {
  let streamSid = null;
  const cbs = { ready: [], audioIn: [], mark: [], hangup: [] };
  const emit = (k, ...args) => cbs[k].forEach((f) => {
    try { f(...args); } catch (e) { console.error('[TWILIO] callback error:', e.message); }
  });
  let hungUp = false;
  const hangupOnce = () => { if (!hungUp) { hungUp = true; emit('hangup'); } };
  const out = (obj) => { if (ws.readyState === ws.OPEN && streamSid) ws.send(JSON.stringify({ ...obj, streamSid })); };

  const session = {
    callId: `tw-${++seq}`,
    callerPhone: null,
    didNumber: null,
    canTransfer: false,
    onReady: (f) => cbs.ready.push(f),
    onAudioIn: (f) => cbs.audioIn.push(f),
    onMark: (f) => cbs.mark.push(f),
    onHangup: (f) => cbs.hangup.push(f),
    sendAudio: (buf) => out({ event: 'media', media: { payload: buf.toString('base64') } }),
    sendMark: (name) => out({ event: 'mark', mark: { name } }),
    clearAudio: () => out({ event: 'clear' }),
    escalate: async () => false,
    hangup() { try { ws.close(); } catch (_) {} },
  };

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        session.callerPhone = msg.start.customParameters?.callerPhone || null;
        session.didNumber = msg.start.customParameters?.didNumber || null;
        emit('ready');
        break;
      case 'media':
        emit('audioIn', Buffer.from(msg.media.payload, 'base64'));
        break;
      case 'mark':
        if (msg.mark?.name) emit('mark', msg.mark.name);
        break;
      case 'stop':
        hangupOnce();
        break;
    }
  });
  ws.on('close', hangupOnce);
  return session;
}

function start({ agent, http }) {
  http.onRequest('POST', '/incoming-call', (req, res, body) => {
    const params = new URLSearchParams(body);
    const caller = params.get('From') || params.get('Caller') || '';
    const did = params.get('To') || params.get('Called') || '';
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${xmlEscape(req.headers.host)}/media-stream">
      <Parameter name="callerPhone" value="${xmlEscape(caller)}" />
      <Parameter name="didNumber" value="${xmlEscape(did)}" />
    </Stream>
  </Connect>
</Response>`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
  });
  http.onWebSocket('/media-stream', (ws) => startCallSession(createTwilioSession(ws), agent));
  console.log('[TWILIO] webhook POST /incoming-call, media stream /media-stream');
}

module.exports = { start, createTwilioSession };

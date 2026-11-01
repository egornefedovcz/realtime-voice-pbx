// Asterisk AudioSocket transport — the minimal way to put an AI on a SIP line.
//
// Why AudioSocket: no ARI, no RTP port range, no bridges — the dialplan hands
// the channel's audio to a TCP socket. On one deployment ARI externalMedia
// audio from the app was silently dropped by the PBX; AudioSocket just worked.
//
// Dialplan (see asterisk/extensions.conf):
//   Set(VB_UUID=<random uuid>)
//   CURL(http://127.0.0.1:<AUDIOSOCKET_HTTP_PORT>/call?uuid=…&caller=…&did=…)   ← AudioSocket only sends the uuid
//   AudioSocket(${VB_UUID},127.0.0.1:<AUDIOSOCKET_PORT>)
//
// Protocol: [type 1 B][length 2 B BE][payload]
//   0x01 UUID, 0x10 audio (slin16, 8 kHz mono), 0x00 hangup, 0xff error.
const net = require('net');
const http = require('http');
const { str, num } = require('../../packages/core/config');
const { startCallSession } = require('../../packages/core/realtime');
const { pcm16ToUlaw, ulawToPcm16 } = require('../../packages/core/audio');

const FRAME = 320; // 20 ms slin16 @ 8 kHz
const callers = new Map(); // uuid -> { caller, did, at }

function frame(type, data) {
  const h = Buffer.alloc(3);
  h[0] = type;
  h.writeUInt16BE(data ? data.length : 0, 1);
  return data ? Buffer.concat([h, data]) : h;
}
const uuidStr = (b) => b.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

function handle(sock, agent) {
  let buf = Buffer.alloc(0), session = null, out = Buffer.alloc(0), marks = [], timer = null, closed = false, next = 0;
  const cbs = { ready: [], audioIn: [], mark: [], hangup: [] };
  const emit = (k, ...a) => cbs[k].forEach((f) => { try { f(...a); } catch (e) { console.error('[AS] callback', e.message); } });
  const end = () => { if (closed) return; closed = true; clearInterval(timer); emit('hangup'); };

  // pacer: 20 ms frames driven by the wall clock, not by the number of ticks
  function tick() {
    const now = Date.now();
    while (next <= now) {
      if (out.length >= FRAME) { sock.write(frame(0x10, out.subarray(0, FRAME))); out = out.subarray(FRAME); }
      else if (out.length) { sock.write(frame(0x10, Buffer.concat([out, Buffer.alloc(FRAME - out.length)]))); out = Buffer.alloc(0); }
      else { next = now + 20; break; }
      next += 20;
    }
    if (!out.length && marks.length) marks.splice(0).forEach((n) => emit('mark', n));
  }

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 3) {
      const type = buf[0], len = buf.readUInt16BE(1);
      if (buf.length < 3 + len) break;
      const data = buf.subarray(3, 3 + len);
      buf = buf.subarray(3 + len);
      if (type === 0x01 && !session) {
        const id = uuidStr(data), info = callers.get(id) || {};
        callers.delete(id);
        session = {
          callId: id.slice(0, 8),
          callerPhone: info.caller && !/^(anonymous|unknown|restricted)$/i.test(info.caller) ? info.caller : null,
          didNumber: info.did || null,
          canTransfer: false,
          onReady: (f) => cbs.ready.push(f), onAudioIn: (f) => cbs.audioIn.push(f), onMark: (f) => cbs.mark.push(f), onHangup: (f) => cbs.hangup.push(f),
          sendAudio: (u) => { out = Buffer.concat([out, ulawToPcm16(u)]); },
          sendMark: (n) => marks.push(n),
          clearAudio: () => { out = Buffer.alloc(0); },
          escalate: async () => false,
          hangup: () => { try { sock.write(frame(0x00)); sock.end(); } catch (_) {} },
        };
        startCallSession(session, agent);
        next = Date.now();
        timer = setInterval(tick, 10);
        emit('ready');
      } else if (type === 0x10 && session) emit('audioIn', pcm16ToUlaw(data));
      else if (type === 0x00) { sock.end(); end(); }
      else if (type === 0xff) console.error('[AS] error from Asterisk', data.toString('hex'));
    }
  });
  sock.on('close', end);
  sock.on('error', (e) => { console.error('[AS] socket', e.message); end(); });
}

function start({ agent }) {
  const host = str('AUDIOSOCKET_HOST', '127.0.0.1');
  const port = num('AUDIOSOCKET_PORT', 9092);
  const httpPort = num('AUDIOSOCKET_HTTP_PORT', 9093);
  net.createServer((sock) => handle(sock, agent)).listen(port, host, () => console.log(`[AS] AudioSocket on ${host}:${port}`));
  // The dialplan stores the caller id under the uuid here right before AudioSocket()
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/call' && u.searchParams.get('uuid')) {
      callers.set(u.searchParams.get('uuid').toLowerCase(), { caller: u.searchParams.get('caller') || '', did: u.searchParams.get('did') || '', at: Date.now() });
      for (const [k, v] of callers) if (Date.now() - v.at > 60e3) callers.delete(k);
    }
    res.end('ok');
  }).listen(httpPort, host, () => console.log(`[AS] caller-id side channel on ${host}:${httpPort}`));
}

module.exports = { start, frame, uuidStr };

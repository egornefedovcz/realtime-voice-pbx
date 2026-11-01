// RTP bridge for Asterisk ARI external media (ulaw / rtp / udp).
//
// Receive: parses RTP, accepts only PCMU (PT 0), drops duplicates and packets
// that arrive after a newer one. That is enough for speech-to-text; we do not
// build a full jitter buffer.
//
// Send: unlike Twilio, Asterisk does not buffer — audio deltas from OpenAI must
// be sent as 160-byte frames every 20 ms. The pacer runs on setInterval(10) and
// corrects the number of frames sent against process.hrtime.bigint(), so system
// timer drift does not accumulate. When the queue runs dry (OpenAI is still
// generating), the anchor is moved forward so no catch-up burst happens when
// more data arrives.
//
// Marks: markWhenDrained(name) fires the callback once the pacer has sent
// everything that was queued before it. This replaces Twilio's 'mark' event and
// is more precise (the pacer knows exactly how much audio has been sent).
//
// Symmetric RTP: the destination is the source of the first received packet.
const dgram = require('dgram');

const FRAME_BYTES = 160;            // 20 ms of µ-law @ 8 kHz
const FRAME_NS = 20_000_000n;
const TICK_MS = 10;
const ULAW_SILENCE = 0xff;
const PT_PCMU = 0;

function parseRtp(msg) {
  if (msg.length < 12) return null;
  if (msg[0] >> 6 !== 2) return null;               // version must be 2
  const hasPadding = !!(msg[0] & 0x20);
  const hasExt = !!(msg[0] & 0x10);
  const cc = msg[0] & 0x0f;                          // CSRC count
  const pt = msg[1] & 0x7f;
  const seq = msg.readUInt16BE(2);
  let offset = 12 + cc * 4;
  if (hasExt) {
    if (msg.length < offset + 4) return null;
    offset += 4 + msg.readUInt16BE(offset + 2) * 4;
  }
  let end = msg.length;
  if (hasPadding) end -= msg[msg.length - 1];
  if (end <= offset) return null;
  return { pt, seq, payload: msg.subarray(offset, end) };
}

class RtpSession {
  constructor(port, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.remote = null;
    this.onPayload = null;
    this.onMark = null;

    this.ssrc = (Math.random() * 0xffffffff) >>> 0;
    this.seq = (Math.random() * 0xffff) >>> 0;
    this.tsNext = (Math.random() * 0xffffffff) >>> 0;
    this.marker = true;                // first packet of a talkspurt carries the marker bit

    this.queue = [];
    this.queuedBytes = 0;
    this.pendingMarks = [];
    this.lastSeqIn = null;
    this.timer = null;
    this.anchorNs = null;
    this.framesSent = 0;
    this.closed = false;

    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (e) => console.error(`[RTP:${this.port}] socket error:`, e.message));
    this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.socket.bind(port, host);
  }

  // Provisional destination taken from the UNICASTRTP_LOCAL_* variables of the
  // externalMedia channel, so the greeting does not depend on the caller
  // sending the first packet.
  setRemote(address, port) {
    if (this.remote && !this.remote.provisional) return;
    this.remote = { address, port, provisional: true };
    console.log(`[RTP:${this.port}] remote set from channel vars: ${address}:${port}`);
  }

  _onMessage(msg, rinfo) {
    if (!this.remote || this.remote.provisional) {
      this.remote = { address: rinfo.address, port: rinfo.port };
      console.log(`[RTP:${this.port}] remote learned: ${rinfo.address}:${rinfo.port}`);
    }
    const pkt = parseRtp(msg);
    if (!pkt || pkt.pt !== PT_PCMU) return;
    if (this.lastSeqIn !== null) {
      const diff = (pkt.seq - this.lastSeqIn) & 0xffff;
      if (diff === 0 || diff > 0x8000) return;       // duplicate or older than the last processed packet
    }
    this.lastSeqIn = pkt.seq;
    if (this.onPayload) this.onPayload(pkt.payload);
  }

  enqueue(buf) {
    if (this.closed || !buf || !buf.length) return;
    this.queue.push(buf);
    this.queuedBytes += buf.length;
    this._ensurePacer();
  }

  markWhenDrained(name) {
    if (this.closed) return;
    this.pendingMarks.push(name);
    this._ensurePacer();
  }

  clear() {
    this.queue = [];
    this.queuedBytes = 0;
    this._fireMarks();                 // nothing will play any more — pending marks fire immediately
  }

  close() {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.socket.close(); } catch (_) {}
  }

  _fireMarks() {
    if (!this.pendingMarks.length) return;
    const marks = this.pendingMarks;
    this.pendingMarks = [];
    for (const name of marks) {
      if (this.onMark) {
        try { this.onMark(name); } catch (e) { console.error(`[RTP:${this.port}] mark cb error:`, e.message); }
      }
    }
  }

  _ensurePacer() {
    if (this.timer || this.closed) return;
    this.anchorNs = process.hrtime.bigint();
    this.framesSent = 0;
    this.marker = true;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _tick() {
    if (this.closed) return;
    if (!this.remote) return;          // destination unknown until the first packet from Asterisk
    const due = Number((process.hrtime.bigint() - this.anchorNs) / FRAME_NS);
    while (this.framesSent < due) {
      let frame = null;
      if (this.queuedBytes >= FRAME_BYTES) {
        frame = this._takeBytes(FRAME_BYTES);
      } else if (this.queuedBytes > 0 && this.pendingMarks.length) {
        // end of a response stream — pad the last short frame with silence
        frame = Buffer.alloc(FRAME_BYTES, ULAW_SILENCE);
        this._takeBytes(this.queuedBytes).copy(frame, 0);
      } else {
        // queue ran dry — move the anchor so missed frames are not sent later as a burst
        this.anchorNs = process.hrtime.bigint() - BigInt(this.framesSent) * FRAME_NS;
        break;
      }
      this._sendFrame(frame);
      this.framesSent++;
    }
    if (this.queuedBytes === 0) {
      this._fireMarks();
      if (this.queuedBytes === 0 && !this.pendingMarks.length) {
        clearInterval(this.timer);
        this.timer = null;
        this.marker = true;
      }
    }
  }

  _takeBytes(n) {
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(n - filled, head.length);
      head.copy(out, filled, 0, take);
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
      filled += take;
    }
    this.queuedBytes -= filled;
    return out;
  }

  _sendFrame(payload) {
    const header = Buffer.alloc(12);
    header[0] = 0x80;                                  // V=2, no padding, no ext, cc=0
    header[1] = (this.marker ? 0x80 : 0x00) | PT_PCMU;
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.tsNext >>> 0, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.marker = false;
    this.seq = (this.seq + 1) & 0xffff;
    this.tsNext = (this.tsNext + FRAME_BYTES) >>> 0;   // 160 samples per frame
    try {
      this.socket.send(Buffer.concat([header, payload]), this.remote.port, this.remote.address);
    } catch (e) {
      console.error(`[RTP:${this.port}] send error:`, e.message);
    }
  }
}

module.exports = { RtpSession, parseRtp, FRAME_BYTES };

// RTP bridge: parsing, pacing (160 B / 20 ms, no burst), mark after drain, clear.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { RtpSession, parseRtp, FRAME_BYTES } = require('../packages/core/rtp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPacket({ seq, pt = 0, cc = 0, ext = false, payload }) {
  const csrc = Buffer.alloc(cc * 4);
  let extBuf = Buffer.alloc(0);
  if (ext) {
    extBuf = Buffer.alloc(4 + 8); // profile(2) + len(2) + 2 words
    extBuf.writeUInt16BE(2, 2);
  }
  const h = Buffer.alloc(12);
  h[0] = 0x80 | (ext ? 0x10 : 0) | cc;
  h[1] = pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(12345, 4);
  h.writeUInt32BE(0xdeadbeef, 8);
  return Buffer.concat([h, csrc, extBuf, payload]);
}

const pl = Buffer.alloc(160, 0x55);

test('parseRtp', () => {
  let p = parseRtp(buildPacket({ seq: 10, payload: pl }));
  assert.strictEqual(p.pt, 0);
  assert.strictEqual(p.seq, 10);
  assert.strictEqual(p.payload.length, 160);
  assert.strictEqual(p.payload[0], 0x55);
  p = parseRtp(buildPacket({ seq: 11, cc: 2, ext: true, payload: pl }));
  assert(p && p.payload.length === 160, 'CSRC + extension header must be skipped');
  assert.strictEqual(parseRtp(Buffer.alloc(5)), null, 'short packet');
});

test('receive, pacing, marks, clear, padding', async () => {
  const rtpPort = 45500;
  const peerPort = 45502;
  const rtp = new RtpSession(rtpPort, '127.0.0.1');
  const peer = dgram.createSocket('udp4');
  await new Promise((r) => peer.bind(peerPort, '127.0.0.1', r));
  try {
    const receivedIn = [];
    rtp.onPayload = (payload) => receivedIn.push(payload);
    const receivedOut = [];
    const t0 = Date.now();
    peer.on('message', (msg) => {
      const pkt = parseRtp(msg);
      receivedOut.push({ t: Date.now() - t0, seq: pkt.seq, len: pkt.payload.length });
    });

    // learn the remote address (symmetric RTP) + check receive / jitter drop
    peer.send(buildPacket({ seq: 100, payload: pl }), rtpPort, '127.0.0.1');
    peer.send(buildPacket({ seq: 101, payload: pl }), rtpPort, '127.0.0.1');
    peer.send(buildPacket({ seq: 101, payload: pl }), rtpPort, '127.0.0.1'); // duplicate
    peer.send(buildPacket({ seq: 99, payload: pl }), rtpPort, '127.0.0.1');  // old
    peer.send(buildPacket({ seq: 102, pt: 8, payload: pl }), rtpPort, '127.0.0.1'); // PCMA — dropped
    await sleep(100);
    assert.strictEqual(receivedIn.length, 2, `expected 2 payloads, got ${receivedIn.length}`);

    // 1 s of audio (8000 B = 50 frames) at once + mark
    let markAt = null;
    rtp.onMark = (name) => { markAt = { name, t: Date.now() - t0 }; };
    rtp.enqueue(Buffer.alloc(8000, 0x11));
    rtp.markWhenDrained('greeting-done');
    await sleep(1400);
    assert.strictEqual(receivedOut.length, 50, `expected 50 frames, sent ${receivedOut.length}`);
    assert(receivedOut.every((x) => x.len === FRAME_BYTES), 'every frame 160 B');
    const first200 = receivedOut.filter((x) => x.t <= 210).length;
    assert(first200 <= 14, `burst! ${first200} frames in the first 200 ms`);
    for (let i = 1; i < receivedOut.length; i++) {
      assert.strictEqual((receivedOut[i].seq - receivedOut[i - 1].seq) & 0xffff, 1, 'contiguous seq');
    }
    assert(markAt && markAt.name === 'greeting-done', 'mark after drain');
    assert(markAt.t >= 900, `mark too early (${markAt.t} ms)`);
    const total = receivedOut[receivedOut.length - 1].t;
    assert(total >= 900 && total <= 1250, `50 frames took ${total} ms (expected ~1000)`);

    // clear (barge-in)
    receivedOut.length = 0;
    markAt = null;
    rtp.enqueue(Buffer.alloc(8000, 0x22));
    rtp.markWhenDrained('response-done');
    await sleep(150);
    rtp.clear();
    const sentBeforeClear = receivedOut.length;
    await sleep(300);
    assert(receivedOut.length <= sentBeforeClear + 1, 'nothing is sent after clear');
    assert(markAt && markAt.name === 'response-done', 'pending mark fires on clear');

    // short last frame is padded with silence
    receivedOut.length = 0;
    rtp.enqueue(Buffer.alloc(100, 0x33));
    rtp.markWhenDrained('short');
    await sleep(200);
    assert.strictEqual(receivedOut.length, 1, 'short tail sent as one frame');
    assert.strictEqual(receivedOut[0].len, FRAME_BYTES);
  } finally {
    rtp.close();
    peer.close();
  }
});

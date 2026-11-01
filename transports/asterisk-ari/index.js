// Asterisk ARI transport: Stasis application + RTP bridge (externalMedia, ulaw).
//
// Call flow:
//   StasisStart(caller channel) → mixing bridge → externalMedia channel (RTP to
//   RTP_HOST:<port> from RTP_PORT_MIN..MAX) → both channels in the bridge →
//   CallSession ready → the realtime core talks to OpenAI.
//
// Live transfer: staff are dialled IN THE BACKGROUND (Local/s@staff-ring) while
// the caller stays in the bridge and hears music on hold. Whoever answers is
// added to the bridge and the AI leaves; if nobody answers, the AI continues in
// the same session. (Moving the caller out of Stasis into a Dial() and back
// caused dead air with some SIP trunks when all phones rejected at once.)
const WebSocket = require('ws');
const { str, num } = require('../../packages/core/config');
const { RtpSession } = require('../../packages/core/rtp');
const { startCallSession } = require('../../packages/core/realtime');
const { staffTargets, routingConfigured } = require('./routing');

const cfg = {
  ARI_URL: str('ARI_URL', 'http://127.0.0.1:8088'),
  ARI_USER: str('ARI_USER', 'voicebot'),
  ARI_PASSWORD: str('ARI_PASSWORD'),
  ARI_APP: str('ARI_APP', 'voicebot'),
  RTP_HOST: str('RTP_HOST', '127.0.0.1'),
  RTP_PORT_MIN: num('RTP_PORT_MIN', 40000),
  RTP_PORT_MAX: num('RTP_PORT_MAX', 40100),
  FALLBACK_NUMBER: str('FALLBACK_NUMBER'),
  RING_TIMEOUT_S: num('RING_TIMEOUT', 30),
  MOH_CLASS: str('MOH_CLASS', 'default'),
  STAFF_CONTEXT: str('STAFF_CONTEXT', 'staff-ring'),
};

const AUTH_HEADER = 'Basic ' + Buffer.from(`${cfg.ARI_USER}:${cfg.ARI_PASSWORD}`).toString('base64');

const calls = new Map();       // caller channelId -> call state
const pendingEm = new Map();   // externalMedia channelId -> resolve (StasisStart arrived)
const usedPorts = new Set();
const pendingStaff = new Map(); // staff channelId -> { call, resolve(answered) }
let agent = null;

async function ari(method, path, params, body) {
  const url = new URL(`${cfg.ARI_URL}/ari${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const opts = { method, headers: { Authorization: AUTH_HEADER } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ARI ${method} ${path} -> ${res.status} ${text}`.trim());
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function allocRtpPort() {
  for (let p = cfg.RTP_PORT_MIN; p <= cfg.RTP_PORT_MAX; p += 2) {
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
  throw new Error('no free RTP port — RTP_PORT_MIN..RTP_PORT_MAX exhausted');
}

function cleanupCall(call) {
  if (call.cleaned) return;
  call.cleaned = true;
  if (call.staffChannelId) {
    finishStaff(call.staffChannelId, false);
    ari('DELETE', `/channels/${call.staffChannelId}`).catch(() => {});
  }
  calls.delete(call.channelId);
  try { call.rtp.close(); } catch (_) {}
  usedPorts.delete(call.port);
  if (call.emChannelId) {
    pendingEm.delete(call.emChannelId);
    ari('DELETE', `/channels/${call.emChannelId}`).catch(() => {});
  }
  if (call.bridgeId) ari('DELETE', `/bridges/${call.bridgeId}`).catch(() => {});
}

// Who can be rung now. PJSIP/<ext> targets only when the endpoint is online —
// otherwise the caller would wait in silence for an empty queue.
async function availableTargets(call) {
  let targets = [];
  try { targets = await staffTargets(); } catch (e) {
    console.error(`[ARI:${call.callId}] staff routing failed:`, e.message);
  }
  const checked = await Promise.all(targets.map(async (t) => {
    const m = /^PJSIP\/([^/@&]+)$/.exec(t);
    if (!m) return t;
    try {
      const ep = await ari('GET', `/endpoints/PJSIP/${m[1]}`);
      return ep && ep.state === 'online' ? t : null;
    } catch (_) {
      return t; // state unknown — better try ringing
    }
  }));
  return checked.filter(Boolean);
}

async function canTransferNow(call) {
  if (!routingConfigured() || call.noTransfer) return false;
  return (await availableTargets(call)).length > 0 || !!cfg.FALLBACK_NUMBER;
}

async function escalateCall(call) {
  if (!routingConfigured()) {
    console.log(`[ARI:${call.callId}] transfer disabled (no SHIFTS_URL, STAFF_DIAL_TARGETS or FALLBACK_NUMBER)`);
    return false;
  }
  if (call.noTransfer) {
    console.log(`[ARI:${call.callId}] nobody answered before — staying with the AI`);
    return false;
  }
  const targets = await availableTargets(call);
  if (!targets.length && !cfg.FALLBACK_NUMBER) {
    console.log(`[ARI:${call.callId}] nobody on shift and no fallback — staying with the AI`);
    return false;
  }
  const ok = await ringTargets(call, targets);
  if (!ok) call.noTransfer = true;
  return ok;
}

async function ringTargets(call, targets) {
  const staffId = `staff-${call.callId}-${Date.now()}`;
  call.staffChannelId = staffId;
  const answered = new Promise((resolve) => pendingStaff.set(staffId, { call, resolve }));
  const timer = setTimeout(() => {
    finishStaff(staffId, false);
    ari('DELETE', `/channels/${staffId}`).catch(() => {});
  }, (cfg.RING_TIMEOUT_S + 10) * 1000);
  await ari('POST', `/bridges/${call.bridgeId}/moh`, { mohClass: cfg.MOH_CLASS })
    .catch((e) => console.error(`[ARI:${call.callId}] MOH start:`, e.message));
  try {
    await ari('POST', '/channels', {
      endpoint: `Local/s@${cfg.STAFF_CONTEXT}/n`,
      app: cfg.ARI_APP,
      appArgs: `staff,${call.callId}`,
      channelId: staffId,
      callerId: call.callerPhone || '',
      timeout: cfg.RING_TIMEOUT_S + 5,
    }, { variables: { DIAL_TARGETS: targets.join('&'), FALLBACK_NUMBER: cfg.FALLBACK_NUMBER, RING_TIMEOUT: String(cfg.RING_TIMEOUT_S) } });
    console.log(`[ARI:${call.callId}] ringing staff: ${targets.join('&') || '(fallback only)'}`);
  } catch (e) {
    console.error(`[ARI:${call.callId}] staff originate failed:`, e.message);
    finishStaff(staffId, false);
  }
  const ok = await answered;
  clearTimeout(timer);
  if (ok) return true;

  console.log(`[ARI:${call.callId}] staff did not answer — back to the AI`);
  call.staffChannelId = null;
  if (!call.cleaned) await ari('DELETE', `/bridges/${call.bridgeId}/moh`).catch(() => {});
  return false;
}

function finishStaff(staffId, answered) {
  const p = pendingStaff.get(staffId);
  if (!p) return;
  pendingStaff.delete(staffId);
  p.resolve(answered);
}

// A staff member answered: AI out of the bridge, human in.
async function connectStaff(call, staffId) {
  await ari('DELETE', `/bridges/${call.bridgeId}/moh`).catch(() => {});
  call.transferred = true;
  if (call.emChannelId) {
    pendingEm.delete(call.emChannelId);
    await ari('DELETE', `/channels/${call.emChannelId}`).catch(() => {});
    call.emChannelId = null;
  }
  try { call.rtp.close(); } catch (_) {}
  usedPorts.delete(call.port);
  await ari('POST', `/bridges/${call.bridgeId}/addChannel`, { channel: staffId });
  call.staffConnected = true;
  console.log(`[ARI:${call.callId}] connected to staff (${staffId})`);
}

async function handleNewCall(channel, args) {
  const callId = channel.id;
  const didNumber = args[0] || null;
  let callerPhone = args[1] || channel.caller?.number || null;
  // Back from the fallback queue context: nobody answered
  const returnedNoAnswer = args[2] === 'noanswer';
  if (callerPhone && /^(anonymous|unknown|restricted|s)$/i.test(callerPhone)) callerPhone = null;

  const port = allocRtpPort();
  const rtp = new RtpSession(port, cfg.RTP_HOST);

  const cbs = { ready: [], audioIn: [], mark: [], hangup: [] };
  const emit = (k, ...a) => cbs[k].forEach((f) => {
    try { f(...a); } catch (e) { console.error(`[ARI:${callId}] callback error:`, e.message); }
  });
  let hungUp = false;

  const call = {
    callId, channelId: callId, didNumber, port, rtp,
    bridgeId: null, emChannelId: null,
    transferred: false, cleaned: false,
    noTransfer: returnedNoAnswer,
    callerPhone,
    staffChannelId: null, staffConnected: false,
    emitHangup: () => { if (!hungUp) { hungUp = true; emit('hangup'); } },
  };
  calls.set(callId, call);

  const session = {
    callId,
    callerPhone,
    didNumber,
    canTransfer: routingConfigured() && !returnedNoAnswer,
    returnedNoAnswer,
    onReady: (f) => cbs.ready.push(f),
    onAudioIn: (f) => cbs.audioIn.push(f),
    onMark: (f) => cbs.mark.push(f),
    onHangup: (f) => cbs.hangup.push(f),
    sendAudio: (buf) => rtp.enqueue(buf),
    sendMark: (name) => rtp.markWhenDrained(name),
    clearAudio: () => rtp.clear(),
    escalate: () => escalateCall(call),
    transferAvailable: () => canTransferNow(call),
    hangup: () => ari('DELETE', `/channels/${callId}`).catch(() => {}),
  };

  rtp.onPayload = (payload) => emit('audioIn', payload);
  rtp.onMark = (name) => emit('mark', name);

  // OpenAI connects right away — the bridge is built in parallel
  startCallSession(session, agent);

  try {
    await ari('POST', `/channels/${callId}/answer`).catch(() => {});

    const bridge = await ari('POST', '/bridges', { type: 'mixing' });
    call.bridgeId = bridge.id;

    const emChannelId = `em-${callId}`;
    call.emChannelId = emChannelId;
    const emStarted = new Promise((resolve, reject) => {
      pendingEm.set(emChannelId, resolve);
      setTimeout(() => reject(new Error('externalMedia StasisStart timeout')), 5000);
    });
    await ari('POST', '/channels/externalMedia', {
      channelId: emChannelId,
      app: cfg.ARI_APP,
      external_host: `${cfg.RTP_HOST}:${port}`,
      format: 'ulaw',
      encapsulation: 'rtp',
      transport: 'udp',
      connection_type: 'client',
      direction: 'both',
    });
    await emStarted;
    pendingEm.delete(emChannelId);

    // where Asterisk expects RTP for this externalMedia channel
    try {
      const [addr, prt] = await Promise.all([
        ari('GET', `/channels/${emChannelId}/variable`, { variable: 'UNICASTRTP_LOCAL_ADDRESS' }),
        ari('GET', `/channels/${emChannelId}/variable`, { variable: 'UNICASTRTP_LOCAL_PORT' }),
      ]);
      if (addr?.value && prt?.value) rtp.setRemote(addr.value, parseInt(prt.value, 10));
    } catch (e) {
      console.error(`[ARI:${callId}] UNICASTRTP vars unavailable (${e.message}) — waiting for the first inbound packet`);
    }

    await ari('POST', `/bridges/${bridge.id}/addChannel`, { channel: callId });
    await ari('POST', `/bridges/${bridge.id}/addChannel`, { channel: emChannelId });

    console.log(`[ARI:${callId}] bridge ${bridge.id} ready, RTP port ${port}`);
    emit('ready');
  } catch (e) {
    console.error(`[ARI:${callId}] call setup failed:`, e.message);
    cleanupCall(call);
    call.emitHangup();
    ari('DELETE', `/channels/${callId}`).catch(() => {});
  }
}

function dispatch(event) {
  switch (event.type) {
    case 'StasisStart': {
      const ch = event.channel;
      if (pendingEm.has(ch.id)) { pendingEm.get(ch.id)(); return; }
      if ((event.args || [])[0] === 'staff') {
        const p = pendingStaff.get(ch.id);
        if (!p || p.call.cleaned) { ari('DELETE', `/channels/${ch.id}`).catch(() => {}); return; }
        connectStaff(p.call, ch.id)
          .then(() => finishStaff(ch.id, true))
          .catch((e) => {
            console.error(`[ARI:${p.call.callId}] connecting staff failed:`, e.message);
            ari('DELETE', `/channels/${ch.id}`).catch(() => {});
            finishStaff(ch.id, false);
          });
        return;
      }
      if (calls.has(ch.id)) return;
      handleNewCall(ch, event.args || []).catch((e) => console.error(`[ARI:${ch.id}] handleNewCall error:`, e.message));
      break;
    }
    case 'StasisEnd': {
      const ch = event.channel;
      const call = calls.get(ch.id);
      if (call && call.staffConnected) {
        // caller hung up while talking to staff
        ari('DELETE', `/channels/${call.staffChannelId}`).catch(() => {});
        ari('DELETE', `/bridges/${call.bridgeId}`).catch(() => {});
        cleanupCall(call);
        call.emitHangup();
        return;
      }
      if (ch.id.startsWith('staff-')) {
        for (const c of calls.values()) {
          if (c.staffChannelId === ch.id && c.staffConnected) {
            // staff hung up → end the caller's leg too
            ari('DELETE', `/channels/${c.channelId}`).catch(() => {});
          }
        }
        finishStaff(ch.id, false);
        return;
      }
      if (call) {
        console.log(`[ARI:${ch.id}] call ended`);
        cleanupCall(call);
        call.emitHangup();
        return;
      }
      // externalMedia channel ended before the call — the bridge is dead, hang up
      for (const c of calls.values()) {
        if (c.emChannelId === ch.id && !c.transferred && !c.cleaned) {
          console.error(`[ARI:${c.callId}] externalMedia channel died, hanging up`);
          ari('DELETE', `/channels/${c.channelId}`).catch(() => {});
        }
      }
      break;
    }
    case 'ChannelDestroyed':
      // background staff dial ended without an answer (busy, DND, no answer)
      if (pendingStaff.has(event.channel.id)) finishStaff(event.channel.id, false);
      break;
  }
}

function connectEvents() {
  const wsUrl = `${cfg.ARI_URL.replace(/^http/, 'ws')}/ari/events?app=${encodeURIComponent(cfg.ARI_APP)}&api_key=${encodeURIComponent(`${cfg.ARI_USER}:${cfg.ARI_PASSWORD}`)}`;
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => console.log(`[ARI] connected, app "${cfg.ARI_APP}" registered`));
  ws.on('message', (data) => {
    let event;
    try { event = JSON.parse(data); } catch (_) { return; }
    try { dispatch(event); } catch (e) { console.error('[ARI] dispatch error:', e.message); }
  });
  ws.on('error', (e) => console.error('[ARI] ws error:', e.message));
  ws.on('close', () => {
    console.error('[ARI] ws closed — reconnecting in 3 s');
    setTimeout(connectEvents, 3000);
  });
}

let started = false;

function start({ agent: a }) {
  if (started) return;
  started = true;
  agent = a;
  if (!cfg.ARI_PASSWORD) {
    console.error('[ARI] ARI_PASSWORD is not set — asterisk-ari transport not started');
    return;
  }
  connectEvents();
}

module.exports = { start };

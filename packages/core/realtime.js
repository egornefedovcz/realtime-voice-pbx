// OpenAI Realtime call session — the transport-independent heart of a call.
//
// Battle-tested behaviour kept from production:
//   * greeting handshake: VAD is OFF until the greeting has been generated AND
//     the transport confirms it was played to the caller (mark 'greeting-done');
//     otherwise line noise interrupts the greeting.
//   * create_response:false + manual response.create: every caller turn is
//     transcribed first, so your onTranscript hook can inject verified data as
//     an internal [SYSTEM] note BEFORE the model answers.
//   * barge-in: caller speech during a response → response.cancel + flush the
//     transport's audio queue.
//   * hallucination filter for known speech-to-text artefacts on silence.
//   * escalation: once per call, when the agent promises a handoff or the
//     transfer tool runs → summary + all escalation notifiers.
//   * live transfer (if the transport supports it): after the "I'll transfer
//     you" sentence has finished playing, session.escalate() rings staff; when
//     nobody answers the same AI session continues.
//
// A transport provides a CallSession:
//   callId, callerPhone, didNumber, canTransfer?, returnedNoAnswer?,
//   onReady(cb), onAudioIn(cb(Buffer µ-law)), onMark(cb(name)), onHangup(cb),
//   sendAudio(Buffer µ-law), sendMark(name), clearAudio(),
//   escalate(ctx) -> Promise<boolean>, transferAvailable?() -> Promise<boolean>, hangup()
const WebSocket = require('ws');
const cfg = require('./config');
const { TYPING_CLIP } = require('./typing');
const { isHallucination, countDigits } = require('./text');
const { summarizeCall } = require('./summary');

const TRANSFER_TOOL_NAME = 'transfer_to_human';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startCallSession(session, agent, { WebSocketImpl = WebSocket, url } = {}) {
  const s = { ...agent.session };
  const model = s.model || cfg.REALTIME_MODEL;
  const call = {
    id: session.callId,
    callerPhone: session.callerPhone || null,
    didNumber: session.didNumber || null,
    caller: null,
    facts: {},
    conversation: [],
    data: {},
    canTransfer: !!session.canTransfer,
    returnedNoAnswer: !!session.returnedNoAnswer,
    staffMissed: !!session.returnedNoAnswer,
    escalated: false,
    startedAt: new Date(),
  };
  const tag = () => `[CALL:${call.id}]`;

  let greetingSent = false;
  let greetingDone = false;      // OpenAI finished generating the greeting
  let greetingPlayed = false;    // transport confirmed the greeting reached the caller
  let waitingForTranscript = false;
  let pendingResponseCreate = false; // wait for the [SYSTEM] item to be confirmed before response.create
  let responseInFlight = false;      // between response.created and response.done — used for barge-in
  let ready = false;
  let typingActive = false;
  let transferRequested = false;
  let transferStarted = false;
  let handoffPromise = null;
  let lookupPromise = Promise.resolve();
  let maxTimer = null;
  let audioChunks = 0;
  const pendingTools = [];

  const ws = new WebSocketImpl(url || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
  });
  const isOpen = () => ws.readyState === WebSocket.OPEN;
  const send = (obj) => { if (isOpen()) ws.send(JSON.stringify(obj)); };
  const systemNote = (text) => send({
    type: 'conversation.item.create',
    item: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `[SYSTEM: ${text} Internal note, not the caller's words — reply in the language the caller is speaking.]` }],
    },
  });

  // ---------- escalation (once per call) ----------
  function handoff(reason) {
    if (handoffPromise) return handoffPromise;
    call.escalated = true;
    handoffPromise = (async () => {
      const summary = agent.summarize
        ? await summarizeCall({ conversation: call.conversation, facts: call.facts, language: agent.summaryLanguage, ownContacts: agent.ownContacts })
        : '';
      const h = {
        callId: call.id, callerPhone: call.callerPhone, didNumber: call.didNumber, caller: call.caller,
        facts: { ...call.facts }, conversation: [...call.conversation], summary, reason, at: new Date().toISOString(),
      };
      console.log(tag(), '[ESCALATION]', reason, '→', agent.escalation.map((n) => n.name).join(', ') || '(no notifiers)');
      await Promise.all(agent.escalation.map((n) => Promise.resolve()
        .then(() => n.notify(h))
        .catch((e) => console.error(tag(), `[ESCALATION:${n.name}]`, e.message))));
    })();
    return handoffPromise;
  }

  // ---------- tools ----------
  const transferTool = {
    name: TRANSFER_TOOL_NAME,
    description: 'Transfers the ongoing call to a live human colleague. Call it as soon as the caller wants to talk to a person.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Briefly what the caller needs (may be empty).' } }, required: [] },
    async handler(args) {
      if (transferStarted || transferRequested) return { status: 'transferring' };
      // First find out whether anybody can take the call — the agent then says
      // either "transferring" or right away that nobody is available (no dead air).
      let available = true;
      try { if (session.transferAvailable) available = await session.transferAvailable(); } catch (_) {}
      handoff(args.reason ? `transfer requested: ${args.reason}` : 'transfer requested');
      if (available) {
        call.conversation.push({ role: 'agent', text: '[transfer to a colleague]' });
        transferRequested = true;
        return { status: 'transferring' };
      }
      console.log(tag(), '[TRANSFER] nobody available — staying with the AI');
      call.staffMissed = true;
      call.conversation.push({ role: 'agent', text: '[transfer: nobody available]' });
      return { status: 'nobody_available' };
    },
  };
  const activeTools = () => [
    ...(call.canTransfer ? [transferTool] : []),
    ...agent.tools.filter((t) => !t.enabled || t.enabled(call)),
  ];

  async function flushTools() {
    const done = await Promise.all(pendingTools.splice(0));
    for (const d of done) {
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: d.call_id, output: JSON.stringify(d.output) } });
    }
    send({ type: 'response.create' });
  }

  // ---------- instructions & session ----------
  async function buildInstructions() {
    let p = await agent.instructions(call);
    // Without the caller's number the model has nothing to use for "use this
    // number" and reaches for the only number in the prompt — your own support
    // line. That happened in production; keep this.
    if (call.callerPhone) {
      p += `\n\nCALLER NUMBER: the caller is calling from ${call.callerPhone}. If they ask you to use "this number" or "the number I'm calling from", use exactly this one. Never make up the caller's number — if you do not know it, ask.`;
    }
    if (call.caller) p += `\n\n${agent.describeCaller(call.caller)}`;
    if (call.canTransfer) p += `\n\n${agent.messages.transferPrompt}`;
    if (call.returnedNoAnswer) p += `\n\n${agent.messages.returnedNoAnswer}`;
    const greeting = call.returnedNoAnswer ? agent.returnGreeting : await agent.greeting(call);
    p += `\n\nCALL OPENING: the very first sentence you say in this call must be exactly this greeting and nothing else: "${greeting}" Say it only once, at the very start.`;
    return p;
  }

  async function configure(enableVad) {
    const instructions = await buildInstructions();
    const language = s.transcribeLanguage ?? cfg.TRANSCRIBE_LANGUAGE;
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model,
        output_modalities: ['audio'],
        instructions,
        tools: activeTools().map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters })),
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: enableVad ? {
              type: 'server_vad',
              threshold: s.vadThreshold ?? cfg.VAD_THRESHOLD,
              prefix_padding_ms: s.vadPrefixMs ?? cfg.VAD_PREFIX_MS,
              silence_duration_ms: s.vadSilenceMs ?? cfg.VAD_SILENCE_MS,
              create_response: false,
            } : null,
            // No transcription `prompt`: on silence the model tends to echo it back
            // as the transcript. A language hint helps a lot on 8 kHz audio.
            transcription: { model: s.transcribeModel || cfg.TRANSCRIBE_MODEL, ...(language ? { language } : {}) },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: s.voice || cfg.VOICE,
            speed: s.speed ?? cfg.VOICE_SPEED,
          },
        },
      },
    });
  }

  async function sendGreeting() {
    if (greetingSent || !isOpen()) return;
    greetingSent = true;
    if (agent.waitForLookupMs > 0) await Promise.race([lookupPromise, sleep(agent.waitForLookupMs)]);
    await configure(false);
    send({ type: 'response.create' });
    console.log(tag(), '[GREETING] sent');
  }

  // ---------- caller turn ----------
  async function onCallerTranscript(transcript) {
    if (!transcript || !transcript.trim()) {
      if (waitingForTranscript) { waitingForTranscript = false; send({ type: 'response.create' }); }
      return;
    }
    if (isHallucination(transcript, agent.hallucinations)) {
      console.log(tag(), '[STT] hallucination filtered:', transcript.slice(0, 40));
      waitingForTranscript = false; // do not answer garbage — wait for real speech
      return;
    }
    console.log(tag(), '[CALLER]', transcript);
    call.conversation.push({ role: 'customer', text: transcript });

    // Caller dictates a number → keyboard typing sound. The answer is queued
    // after it, so the clip always finishes; lookups are faster than the clip.
    if (agent.typingSound && countDigits(transcript) >= 4 && !typingActive) {
      typingActive = true;
      session.sendAudio(TYPING_CLIP);
    }

    let notes = [];
    if (agent.onTranscript) {
      try {
        const r = await agent.onTranscript(transcript, call);
        notes = (Array.isArray(r) ? r : [r]).filter(Boolean);
      } catch (e) { console.error(tag(), '[onTranscript]', e.message); }
    }
    if (notes.length) {
      pendingResponseCreate = true;
      systemNote(`${notes.join(' | ')}. Use ONLY this data. Do NOT make anything up.`);
    }
    if (waitingForTranscript) {
      waitingForTranscript = false;
      if (!pendingResponseCreate) send({ type: 'response.create' });
    }
  }

  // ---------- agent turn ----------
  function onAgentTranscript(text) {
    console.log(tag(), '[AGENT]', text);
    if (!text || !greetingDone) return;
    call.conversation.push({ role: 'agent', text });
    const low = text.toLowerCase();
    const live = call.canTransfer && agent.transferPhrases.some((r) => r.test(low));
    if (live || agent.handoffPhrases.some((r) => r.test(low))) {
      handoff(live ? 'agent announced a transfer' : 'agent promised a follow-up');
      // Only an explicit "I'm transferring you" transfers; "I'll pass it on" stays asynchronous.
      if (live) transferRequested = true;
    }
  }

  ws.on('open', () => {
    console.log(tag(), '[OPENAI] connected');
    if (ready) sendGreeting();
  });

  ws.on('message', (data) => {
    let event;
    try { event = JSON.parse(data); } catch (_) { return; }
    switch (event.type) {
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        audioChunks++;
        if (event.delta) session.sendAudio(Buffer.from(event.delta, 'base64'));
        break;

      case 'response.audio.done':
      case 'response.output_audio.done':
        audioChunks = 0;
        session.sendMark(greetingDone ? 'response-done' : 'greeting-done');
        break;

      case 'response.created':
        responseInFlight = true;
        break;

      case 'response.function_call_arguments.done': {
        const tool = activeTools().find((t) => t.name === event.name);
        let args = {};
        try { args = JSON.parse(event.arguments || '{}'); } catch (_) {}
        console.log(tag(), '[TOOL]', event.name);
        const run = tool
          ? Promise.resolve().then(() => tool.handler(args, call, { handoff }))
          : Promise.resolve({ error: `unknown tool ${event.name}` });
        pendingTools.push(run.then(
          (output) => ({ call_id: event.call_id, output: output ?? { status: 'ok' } }),
          (err) => ({ call_id: event.call_id, output: { error: `The system is not reachable right now: ${err.message}` } }),
        ));
        break;
      }

      case 'response.done':
        responseInFlight = false;
        typingActive = false;
        if (!greetingDone) {
          greetingDone = true;
          console.log(tag(), '[GREETING] generated, enabling VAD');
          configure(true).catch((e) => console.error(tag(), '[CONFIG]', e.message));
        }
        if (pendingTools.length) flushTools().catch((e) => console.error(tag(), '[TOOLS]', e.message));
        break;

      case 'conversation.item.created':
      case 'conversation.item.added':
        // [SYSTEM] note confirmed (GA API emits 'added') → now generate the answer
        if (pendingResponseCreate) {
          pendingResponseCreate = false;
          send({ type: 'response.create' });
        }
        break;

      case 'input_audio_buffer.speech_started':
        if (responseInFlight) {
          // Barge-in: the caller started talking while the agent was speaking
          send({ type: 'response.cancel' });
          try { session.clearAudio(); } catch (_) {}
          responseInFlight = false;
          console.log(tag(), '[BARGE-IN] response cancelled, transport audio flushed');
        }
        break;

      case 'input_audio_buffer.committed':
        waitingForTranscript = true;
        break;

      case 'conversation.item.input_audio_transcription.completed':
        onCallerTranscript(event.transcript).catch((e) => console.error(tag(), '[TRANSCRIPT]', e.message));
        break;

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        onAgentTranscript(event.transcript);
        break;

      case 'error':
        console.error(tag(), '[OPENAI ERROR]', JSON.stringify(event.error));
        break;
    }
  });

  ws.on('close', (code) => console.log(tag(), '[OPENAI] disconnected', code));
  ws.on('error', (err) => console.error(tag(), '[OPENAI] error:', err.message));

  session.onReady(() => {
    ready = true;
    // Some transports (Twilio) learn the caller id only now
    call.id = session.callId;
    call.callerPhone = session.callerPhone || null;
    call.didNumber = session.didNumber || null;
    if (call.callerPhone) call.facts.callerPhone = call.callerPhone;
    console.log(tag(), '[CALL] started, caller:', call.callerPhone || 'hidden', 'did:', call.didNumber || '-');

    const maxSec = s.maxCallSeconds ?? cfg.MAX_CALL_SECONDS;
    if (maxSec > 0) {
      maxTimer = setTimeout(() => { console.log(tag(), '[CALL] max duration reached, hanging up'); session.hangup(); }, maxSec * 1000);
      maxTimer.unref();
    }

    // Caller lookup runs in the background; the result goes into the
    // instructions (not into the conversation) once it arrives.
    if (agent.lookupCaller && call.callerPhone) {
      lookupPromise = Promise.resolve()
        .then(() => agent.lookupCaller(call.callerPhone, call))
        .then((rec) => {
          if (!rec) return;
          call.caller = rec;
          console.log(tag(), '[LOOKUP] caller known');
          if (isOpen() && greetingDone) configure(true).catch(() => {});
        })
        .catch((e) => console.error(tag(), '[LOOKUP]', e.message));
    }
    if (isOpen()) sendGreeting();
  });

  session.onAudioIn((buf) => {
    // Forward caller audio only after the greeting has fully played
    if (greetingDone && greetingPlayed && !transferStarted && isOpen()) {
      send({ type: 'input_audio_buffer.append', audio: buf.toString('base64') });
    }
  });

  session.onMark((name) => {
    if (name === 'greeting-done') {
      greetingPlayed = true;
      console.log(tag(), '[GREETING] played to caller, listening');
    }
    // Live transfer: the handoff sentence has finished playing, now ring staff
    if (name === 'response-done' && transferRequested && !transferStarted) {
      transferStarted = true;
      Promise.resolve(session.escalate({
        callerPhone: call.callerPhone, caller: call.caller, facts: call.facts, conversation: call.conversation,
      })).then((ok) => {
        if (ok) {
          console.log(tag(), '[TRANSFER] call handed to a human');
          try { ws.close(); } catch (_) {}
          return;
        }
        // Nobody answered / transfer unavailable — the call continues with the AI in the same session
        transferStarted = false;
        transferRequested = false;
        call.staffMissed = true;
        call.conversation.push({ role: 'agent', text: '[transfer: colleague did not answer]' });
        if (isOpen()) {
          systemNote(agent.messages.transferFailed);
          send({ type: 'response.create' });
        }
      }).catch((e) => {
        console.error(tag(), '[TRANSFER] failed:', e.message);
        transferStarted = false;
        transferRequested = false;
      });
    }
  });

  session.onHangup(() => {
    if (maxTimer) clearTimeout(maxTimer);
    if (agent.onCallEnd) Promise.resolve().then(() => agent.onCallEnd(call)).catch((e) => console.error(tag(), '[onCallEnd]', e.message));
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch (_) {}
    }
  });

  return call;
}

module.exports = { startCallSession, TRANSFER_TOOL_NAME };

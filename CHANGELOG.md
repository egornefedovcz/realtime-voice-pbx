# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-01

First public release, extracted from a production customer-support phone line.

### Added
- `packages/core`: transport-independent OpenAI Realtime call session (GA API,
  `audio/pcmu`) with greeting handshake, server VAD after the greeting, barge-in,
  hallucination filter, manual response creation with `[SYSTEM]` grounding notes,
  function-calling tools, live-transfer tool, once-per-call escalation with an
  LLM summary based on verified facts, max call duration, typing sound.
- `defineAgent()` plug-in interface: instructions, greeting, `lookupCaller`,
  `onTranscript`, tools, escalation notifiers, messages, phrases, hooks.
- Escalation notifiers: webhook, SMTP e-mail, Chatwoot (with repeat-call de-duplication), console.
- File-based knowledge base with an instruction-size guard; business-hours helper.
- Transports: Yeastar P-Series WebSocket audio (PCM16 ⇄ µ-law, emulated marks),
  Asterisk ARI + RTP external media (hrtime-corrected pacer, background staff
  ringing with music on hold, rota API / static targets, fallback number),
  Asterisk AudioSocket, Twilio Media Streams.
- Sample Asterisk configs: dialplan, ARI/HTTP, generic PJSIP trunk and staff templates, render scripts.
- `tools/call-transcripts`: MixMonitor recordings → ffmpeg → `gpt-4o-transcribe`
  → JSON summary with retention; weekly digest of recurring questions.
- Examples: pottery studio (full), minimal, HTTP-backend agent.
- Offline test suite (`node:test`) and CI.

[Unreleased]: https://github.com/egornefedovcz/realtime-voice-pbx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/egornefedovcz/realtime-voice-pbx/releases/tag/v0.1.0

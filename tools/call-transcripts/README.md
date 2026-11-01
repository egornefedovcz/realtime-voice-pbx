# call-transcripts

Turns Asterisk call recordings into searchable transcripts and a weekly list of
"what callers keep asking about", so you fix the website and the process, not
just answer the same question again.

```
MixMonitor WAV ──► ffmpeg (mono 16 kHz mp3) ──► gpt-4o-transcribe ──► gpt-4o JSON summary ──► data/YYYY-MM-DD/*.json
                                                                                         └──► weekly-digest.js ──► digest.html / webhook
```

* Nothing leaves your server except the OpenAI API calls.
* Transcripts older than `RETENTION_DAYS` (default 90) are deleted on every run.
* Empty calls (< ~2 s of audio) are marked `empty` and not sent to the API.

## Setup

1. Record calls in the dialplan (see `[record]` in
   `transports/asterisk-ari/asterisk/extensions.conf`):
   ```
   same => n,MixMonitor(${STRFTIME(${EPOCH},,%Y/%m/%d)}/${STRFTIME(${EPOCH},,%H%M%S)}-${CALLERID(num)}-${UNIQUEID}.wav,b)
   ```
   Tell callers the call is recorded, and check the law in your country.
2. Install `ffmpeg` (provides `ffprobe` too).
3. Configure `.env` (shared with the voice service, or a separate file via `ENV_FILE`):

| Variable | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` |, | required |
| `RECORDINGS_DIR` | `/var/spool/asterisk/monitor` | MixMonitor output |
| `TRANSCRIPTS_DIR` | `tools/call-transcripts/data` | JSON output |
| `RETENTION_DAYS` | `90` | delete older transcripts |
| `TRANSCRIPTION_MODEL` | `gpt-4o-transcribe` | |
| `TRANSCRIBE_LANGUAGE` | (auto) | e.g. `cs`, strongly recommended for non-English calls |
| `SUMMARY_MODEL` | `gpt-4o` | |
| `SUMMARY_LANGUAGE` | `English` | language of summaries / digest |
| `BUSINESS_CONTEXT` | `a small business` | one line that helps the summarizer, e.g. "a pottery studio offering classes" |
| `DIGEST_WEBHOOK_URL` |, | where weekly-digest.js POSTs `{subject, html, digest}` |

4. Cron:
   ```cron
   */15 * * * * cd /opt/realtime-voice-pbx && flock -n /tmp/call-transcripts.lock timeout 30m node tools/call-transcripts/transcribe.js >> /var/log/call-transcripts.log 2>&1
   30 7 * * 1  cd /opt/realtime-voice-pbx && node tools/call-transcripts/weekly-digest.js >> /var/log/call-transcripts.log 2>&1
   ```

## Output

```json
{
 "file": "2026/11/02/101530-15550100-1730540130.42.wav",
 "startedAt": "2026-11-02T10:12:01.000Z",
 "seconds": 209,
 "transcript": "…",
 "summary": { "topic": "Moving a booking", "product": "Wheel throwing", "summary": "…", "problem": "…",
              "website_suggestion": "…", "process_suggestion": null, "resolved": true }
}
```

## Cost

`gpt-4o-transcribe` is billed per audio minute; the summary is a few hundred
tokens per call. Check current OpenAI pricing before enabling on a busy line.

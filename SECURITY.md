# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting ("Security" tab → "Report a vulnerability") on this repository.
You will get an answer within a few days. Please include steps to reproduce and
the affected transport / version.

## Supported versions

Only the latest release receives security fixes.

## Deployment hardening

This service sits between the public phone network and paid APIs. Recommended:

- **Never expose Asterisk ARI / HTTP (port 8088) or the AudioSocket ports
  publicly.** The samples bind them to `127.0.0.1`.
- Restrict SIP and RTP to your provider's IP ranges with a firewall; use
  fail2ban or similar against SIP scanning.
- Keep the `[outbound]` dialplan deny-by-default and capped (`MAX_OUTBOUND`) —
  live transfer to external numbers is a toll-fraud surface.
- Use a long random `YEASTAR_SECRET` and TLS (`wss://`) for the Yeastar stream.
- Twilio webhooks are not signature-validated by this project; put them behind a
  reverse proxy check or an unguessable path if that matters to you.
- Keep `.env` out of version control (`chmod 600`). Rendered Asterisk configs
  contain passwords, `chmod 640`, owned by `root:asterisk`.
- Call transcripts and recordings contain personal data: inform callers, limit
  access and keep `RETENTION_DAYS` as short as your use case allows.
- Prompt injection is possible over the phone like anywhere else: tools should
  only return data the caller is allowed to hear (e.g. verify identity before
  reading out order details) and never perform irreversible actions without
  server-side checks.

## Goal

Place an outbound call from Sam to your phone using the Dial page, with the same audio quality and echo-gating that's now working on inbound.

## What needs to change

The outbound function (`telnyx-outbound-call`) was written before we fixed inbound. It still uses `stream_track: "both_tracks"`, which on inbound caused Sam to hear his own TTS bleed back in and loop on himself. We need to match the inbound config exactly, since the bridge (transcoding + echo gate) is already format-agnostic to direction.

### Code change — `supabase/functions/telnyx-outbound-call/index.ts`

Change the `telnyxDial` call so it matches `telnyx-inbound`'s `answer` config:

- `stream_track: "both_tracks"` → `stream_track: "inbound_track"` (caller's mic only — Sam's TTS goes back via the bidirectional WS, not via the echo of the outbound mix)
- Everything else (`stream_codec: "PCMU"`, `stream_bidirectional_mode: "rtp"`, `stream_bidirectional_codec: "PCMU"`) stays the same — already correct.

That's the only code change.

### Deploy

Deploy `telnyx-outbound-call` so the new config is live.

## Test procedure

1. You go to `/admin/dial` in the app.
2. Pick the tenant + your Telnyx caller-ID number.
3. Paste a single line: `Chris, +1XXXXXXXXXX` (your cell).
4. Click "Start dialing".
5. Your phone rings. Answer it. Have a short conversation with Sam.
6. Hang up and tell me:
   - Did it ring through?
   - Could you hear Sam clearly (no static)?
   - Did Sam hear you (no looping/echo)?
   - Any weirdness vs. the inbound call that just worked?

I'll pull the bridge logs after and confirm everything looks clean (vad_score firing, echo-gate dropping when expected, no codec warnings).

## What we're NOT changing

- The bridge itself — already proven on inbound, it doesn't care about direction.
- ElevenLabs config — same agent, same `pcm_16000` negotiation.
- DB schema, RLS, auth — none of it needs to move.

## Risks / things I'll watch for in logs

- **Telnyx rejects the dial** — usually a connection_id / from_number mismatch. The function already returns the Telnyx error body, so we'll see it immediately in the toast + logs.
- **Call connects but no audio** — would mean the outbound media format negotiation differs from inbound. Bridge logs will show the same `media_format` line we saw for inbound; if it's not PCMU/8000 we adjust.
- **Echo loop returns** — shouldn't, since the gate is generic, but if it does we tune `AGENT_SPEAK_TAIL_MS`.

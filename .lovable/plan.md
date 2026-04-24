

## Root cause (verified against Manus report + Telnyx docs)

The bridge is missing **one Telnyx dial parameter**: `stream_bidirectional_mode: "rtp"`. Without this flag, Telnyx opens the WebSocket in inbound-only mode. When our bridge sends agent audio back (the greeting), Telnyx treats the frames as protocol violations and tears down the stream after a handful of inbound media frames — exactly the "9 frames then STOP" we observed.

My previous theories were wrong:
- ❌ "Missing stream_id on outbound frames" — Manus confirmed outbound frames must NOT include stream_id
- ❌ "Format mismatch on EL side" — irrelevant, stream died before EL could process anything
- ✅ "Bidirectional mode not enabled" — the actual cause, and we explicitly omitted it with an incorrect comment

## Fix (3 small changes, one file each)

### 1. `supabase/functions/_shared/telnyx.ts`
- Remove the incorrect "intentionally omitted" comment
- Add `stream_bidirectional_mode?: "rtp"` and `stream_bidirectional_codec?: "PCMU" | "PCMA" | ...` to the `telnyxDial` params type

### 2. `supabase/functions/telnyx-outbound-call/index.ts`
- Add `stream_bidirectional_mode: "rtp"` and `stream_bidirectional_codec: "PCMU"` to the `telnyxDial` call

### 3. `supabase/functions/telnyx-inbound/index.ts`
- Add `stream_bidirectional_mode: "rtp"` and `stream_bidirectional_codec: "PCMU"` to the `telnyxCallControl(..., "answer", ...)` payload (for inbound calls, same fix)

### 4. `supabase/functions/telnyx-bridge/index.ts` — small cleanup
- Since EL can natively handle 8kHz µ-law (per Manus report), switch the EL initiation to use µ-law directly and remove the upsample/downsample/transcode pipeline. This eliminates an entire class of potential format issues.
  - `asr.user_input_audio_format: "ulaw_8000"`
  - `tts.agent_output_audio_format: "ulaw_8000"`
  - Forward Telnyx payload base64 directly to EL as `user_audio_chunk` (no decode/upsample)
  - Forward EL `audio_event.audio_base_64` directly to Telnyx (no downsample/encode)
- Keep all existing logging so we can see frame counts and VAD scores
- Keep outbound frame format exactly as-is: `{event: "media", media: {payload}}` — Manus confirmed this is correct

## What success looks like in the next test call

```
Telnyx START stream_id=<id>  format=PCMU 8000Hz
EL open — using ulaw_8000 both directions
EL ready
FIRST caller audio received from Telnyx
FIRST user_audio_chunk sent to EL (ulaw_8000, raw passthrough)
Telnyx media frames: 250  ← key signal: stream stays alive past 9 frames
FIRST vad_score=0.X  ← EL is decoding our audio
user_transcript: "<your words>"
agent_response: "<reply>"
FIRST agent audio sent to Telnyx
```

If frame count climbs past 9 → bidirectional fix worked. If VAD then fires → format passthrough worked. If both happen → call is functional end-to-end.

## Out of scope

Browser widget, GHL, EL dashboard config, auth flows. One targeted protocol fix.


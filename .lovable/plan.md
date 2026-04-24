

## Why your 15s of talking never got logged

The bridge logs prove Telnyx never sent us audio:
```
Telnyx WS open
Telnyx connected frame
(no start frame, no media frames, ever)
Telnyx closed → streaming.failed → call.hangup
```

A `connected` frame just means the WebSocket handshake worked. The `start` frame is what Telnyx sends right before it begins streaming caller audio. We never got it. So when you spoke, Telnyx had nowhere to send those packets — the media negotiation had already failed on its side.

## Root cause

Our dial/answer payloads include:
- `stream_bidirectional_mode: "rtp"`
- `stream_bidirectional_codec: "PCMU"`

That tells Telnyx: "set up a separate RTP-over-UDP path for agent audio." We don't have one. Telnyx fails the negotiation → `streaming.failed` → tears down the WebSocket before any audio flows.

Our bridge is built for the **WebSocket-only** bidirectional protocol (JSON `media` frames both ways). We just need to stop asking for RTP mode.

## Fix

**1. `supabase/functions/telnyx-outbound-call/index.ts`** — remove `stream_bidirectional_mode` and `stream_bidirectional_codec` from the dial.

**2. `supabase/functions/lead-opt-in-webhook/index.ts`** — same removal in `placeDial`.

**3. `supabase/functions/telnyx-inbound/index.ts`** — already clean on the answer (no bidirectional_mode). Leave as-is.

**4. `supabase/functions/_shared/telnyx.ts`** — remove the two RTP fields from the `telnyxDial` type so they can't be reintroduced.

**5. `supabase/functions/telnyx-bridge/index.ts`** — add one diagnostic: log every raw Telnyx frame `event` type for the first 5 frames, and log Telnyx close code/reason explicitly. Confirms `start` arrives on the next test.

**6. Deploy** all four functions, then place one test call. Expected new log sequence:
```
Telnyx WS open
connected
start ← this is the new line we need to see
FIRST caller audio received
EL ready
FIRST agent audio sent
```

If `start` appears and audio flows, you'll hear Sam. If `start` still doesn't appear after removing the RTP params, the new close-code log will tell us exactly what Telnyx is rejecting.

## What stays out of scope

- Number assignment (already fixed in portal)
- ElevenLabs auth (logs show `EL open` and `EL ready` — working)
- Webhook routing (events arrive correctly)
- Bridge JSON frame format (already correct for WebSocket mode)

Approve and I'll implement and deploy in default mode.


# OmniVoice TTS Sandbox

Test-only path for swapping ElevenLabs TTS with OmniVoice. **Does not touch the live caller.**

## Live, untouched

- `supabase/functions/telnyx-bridge`
- `supabase/functions/telnyx-outbound-call`
- `supabase/functions/telnyx-inbound`
- `supabase/functions/scheduled-call-worker`
- All ElevenLabs agents/voice settings/prompts

## Sandbox functions

- `supabase/functions/telnyx-bridge-omnivoice` — clone of live bridge with optional OmniVoice TTS layer.
- `supabase/functions/telnyx-outbound-call-omnivoice` — clone of live outbound; streams to `telnyx-bridge-omnivoice`.

ElevenLabs is still the conversation brain (ASR, dialog, tool calls). When OmniVoice is enabled for Sam, the bridge:
1. Suppresses ElevenLabs `audio_event` playback (no double audio).
2. Takes the EL `agent_response` text.
3. POSTs it to `${OMNIVOICE_TTS_URL}/synthesize`.
4. Converts the returned 24 kHz PCM s16le → 8 kHz PCMU → Telnyx media frames on the active `stream_id`.

If OmniVoice is disabled or its URL is missing, this bridge behaves identically to the live ElevenLabs bridge.

## Required secrets (set in Lovable Cloud → backend secrets)

| Name | Default | Required when |
|---|---|---|
| `OMNIVOICE_TTS_ENABLED` | `false` | always (set `true` to activate) |
| `OMNIVOICE_TTS_URL` | _(unset)_ | when enabled — public HTTPS base URL of the OmniVoice service |
| `OMNIVOICE_INSTRUCT` | `male, american accent, middle-aged, moderate pitch` | optional |
| `OMNIVOICE_NUM_STEP` | `4` | optional |
| `OMNIVOICE_TIMEOUT_MS` | `12000` | optional |
| `OMNIVOICE_AGENT_KINDS` | `sam` | optional, comma-separated (`sam`, `chris`) |
| `ELEVENLABS_AGENT_MUTATION_ENABLED` | `false` | safety guard — keep `false` unless explicitly mutating EL agents |

Existing `ELEVENLABS_OUTBOUND_AGENT_ID` / `ELEVENLABS_AGENT_ID_OUTBOUND` continue to be used for the outbound Sam agent. The sandbox never creates or patches ElevenLabs agents while the mutation guard is `false`.

## Enable / disable

- Enable:  set `OMNIVOICE_TTS_ENABLED=true` and `OMNIVOICE_TTS_URL=https://…`.
- Disable: set `OMNIVOICE_TTS_ENABLED=false` (or unset `OMNIVOICE_TTS_URL`). Sandbox bridge then falls back to EL audio.

## How to invoke for Chris's test number (+17276374672)

Only after Chris explicitly confirms:

```bash
curl -X POST \
  "https://<PROJECT>.functions.supabase.co/telnyx-outbound-call-omnivoice" \
  -H "Authorization: Bearer <ADMIN_USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "<TENANT_UUID>",
    "to_number": "+17276374672",
    "test_call": true,
    "caller_name": "Chris"
  }'
```

Or call from the admin UI by temporarily pointing the `DialPage` `supabase.functions.invoke` target to `telnyx-outbound-call-omnivoice`.

Returns `{ conversation_id, call_control_id }` just like the live function.

## Rollback

- Soft: `OMNIVOICE_TTS_ENABLED=false` → sandbox bridge serves EL audio again.
- Hard: stop calling `telnyx-outbound-call-omnivoice`. The live `telnyx-outbound-call` was never modified.
- Nuclear: delete the two `*-omnivoice` functions.

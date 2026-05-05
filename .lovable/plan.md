## Root cause

ElevenLabs is killing every WebSocket from `telnyx-bridge` immediately after handshake with:

```
code=1008 reason="Override for field 'first_message' is not allowed by config."
```

The bridge sends `conversation_config_override.agent.first_message`, but the EL agent does not have first-message overrides enabled. EL closes the session, so no agent audio and no transcripts are produced — matching the DB result (`media_frame_count=1045`, `transcript_entries=0`). The bridge auto-reconnects, producing the ~80 identical 1008 close errors in logs.

## Fix (telnyx-bridge only, no EL agent changes)

Edit `supabase/functions/telnyx-bridge/index.ts`, in the `socket.onopen` handler (~line 424):

1. Remove the entire `agent: { first_message: samFirstMessage }` block from `conversationConfigOverride`. Keep `asr`, `tts`, and `conversation.client_events` overrides — only the `agent` block triggers 1008.
2. Keep `dynamic_variables.first_name` and `caller_name` exactly as-is so the agent's existing prompt can substitute them.
3. Leave `samFirstMessage` / `SAM_PHONE_UNKNOWN_FIRST_MESSAGE` defined (harmless) but unused at this site.

Resulting handshake:

```text
conversation_initiation_client_data
  conversation_config_override:
    asr: { user_input_audio_format: pcm_16000 }
    tts: { agent_output_audio_format: pcm_16000 }
    conversation: { client_events: [...] }
  dynamic_variables:
    first_name, caller_name, caller_phone, caller_email,
    company_name, tenant_timezone, tenant_id, conversation_id
-> EL stays open, audio + transcripts flow
```

## Caveat on the opener

This restores audio and transcripts. It does NOT guarantee Sam's first spoken line is `"Hey — is this Chris?"` — that depends entirely on what the deployed ElevenLabs agent has saved as its `first_message` and whether its prompt/first message references `{{first_name}}`. Since you've asked us not to touch the agent config, the opener will be whatever the agent is currently configured to say. If it ends up generic, the next step (separate task) is to enable `first_message` overrides on the agent in the EL dashboard, then re-add the override here.

## Deploy + verify

1. Deploy only `telnyx-bridge`.
2. Place an outbound test call to +17276374672 with `caller_name="Chris"`.
3. In `telnyx-bridge` logs confirm:
   - `EL open` + `EL META` (already present).
   - NO `EL closed code=1008 reason="Override for field 'first_message' ..."`.
   - At least one `vad_score`, `agent_response`, and `user_transcript` event.
4. DB row: `transcript_entries > 0`. Caller hears Sam speak.

## Not changed

- `SAM_SCRIPT`, agent IDs, voice, turn settings, EL agent platform settings.
- `elevenlabs-conversation-token`, `telnyx-outbound-call`, `telnyx-inbound`.
- DB schema / migrations.
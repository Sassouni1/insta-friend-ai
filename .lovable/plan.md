# Plan — Fix the static (codec mismatch)

## What we know from the last test call

- Bidirectional audio is now flowing end-to-end (2127 frames each way) — the `stream_id` fix worked.
- Caller heard **extreme static** instead of Sam's voice.
- ElevenLabs never returned a `vad_score`, meaning EL also couldn't decode our inbound audio.
- Conclusion: **codec/format mismatch in both directions**. We're labeling everything `ulaw_8000` but at least one side isn't actually using µ-law.

## Step 1 — Add diagnostic logging (one deploy, one test call)

Add three log lines to `telnyx-bridge/index.ts`:

1. Log the full `conversation_initiation_metadata` frame from EL — this shows the audio formats EL *actually* negotiated (vs. what we requested in the override).
2. Log the first 32 bytes (hex) of the first inbound Telnyx media payload — confirms it's raw µ-law samples.
3. Log the first 32 bytes (hex) of the first EL `audio` frame payload — tells us if EL sent raw µ-law, PCM, or wrapped audio.

No behavior changes. Just instrumentation. Then place one test call.

## Step 2 — Fix based on what step 1 reveals

Three possible outcomes, three different fixes:

**(a) EL metadata says `pcm_16000` (our override was ignored):**
The agent's dashboard "Output format" is locked. Two options:
- Change the agent's output format to `ulaw_8000` in the ElevenLabs dashboard (no code change, fastest).
- Or transcode PCM 16kHz → µ-law 8kHz in the bridge before sending to Telnyx (more complex, keeps dashboard untouched).

**(b) EL metadata says `ulaw_8000` but the audio bytes look like PCM/WAV:**
EL is wrapping the audio. Strip the wrapper or decode differently before forwarding to Telnyx.

**(c) EL metadata says `ulaw_8000` and bytes look like µ-law, but Telnyx still produces static:**
The raw bytes are correct but Telnyx expects a different framing (e.g. specific frame size like 160 bytes per 20ms). Add reframing/buffering.

## Step 3 — Re-test and confirm

One more test call. Success = caller hears Sam clearly with no static and EL returns `vad_score` events.

## What Chris needs to do

1. Approve this plan so I can add the diagnostic logging.
2. Place one test call after I deploy.
3. Report what you hear (still static? silence? partial words? clear voice?).

## Technical notes

- The `agent_output_audio_format` and `user_input_audio_format` overrides in `conversation_initiation_client_data` are documented as supported, but agent dashboard settings can override them silently — this is a known EL gotcha.
- Telnyx WebSocket bidirectional mode expects raw base64 µ-law samples in 20ms frames (160 bytes per frame at 8kHz). Wrong sample rate or wrong encoding produces the exact "extreme static" symptom.
- No database or auth changes needed for any of these fixes.

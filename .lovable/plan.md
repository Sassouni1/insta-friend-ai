

## Honest status

The full back-and-forth conversations from earlier today (02:14–03:23) were over the **browser widget** (`direction = 'web'`), not phone calls. The phone path (`direction = 'outbound'`, started 06:40+) has never worked end-to-end. So we haven't regressed — we just haven't ever made the phone path actually carry your voice into ElevenLabs successfully. The agent's opening line plays because that's pure TTS output. Your voice never gets transcribed because the audio format we send to ElevenLabs doesn't match what the agent expects.

## Root cause

In `telnyx-bridge`, we receive 8kHz µ-law from Telnyx, decode it to PCM, **upsample to 16kHz PCM**, and send it to ElevenLabs. But we never told ElevenLabs we're sending 16kHz PCM. The agent's input format setting in the EL dashboard governs how it decodes incoming audio. If those don't match, EL receives garbled audio, never detects speech, and sits silent.

Same on the return path: EL sends audio at whatever its TTS output format is set to (likely 16kHz PCM by default for convai websocket), we downsample and µ-law-encode it. That part appears to work since you heard the opening line.

## Fix plan

1. **Pin the audio format both directions in the EL handshake.** In `telnyx-bridge` `conversation_initiation_client_data`, include explicit input/output audio format hints so EL stops assuming. Telephony-friendly path: tell EL we'll send `pcm_16000` user audio (what we already send) and request `pcm_16000` agent audio (what we already downsample from). This removes guesswork on EL's side.

2. **Verify against EL agent dashboard config.** If the agent in EL is set to `ulaw_8000` input, our 16k PCM is being thrown away. The cleanest fix is to make the bridge match EL's actual configured format. I'll read the agent config via the EL API at bridge startup and adapt — log the configured `user_input_audio_format` and `agent_output_audio_format` so we can see what EL actually expects, then transcode accordingly instead of guessing.

3. **Add a "first user_audio_chunk acknowledged" diagnostic.** EL emits `vad_score` events when it's hearing audio. Log the first VAD event (or warn after 3s of audio sent with no VAD events) — that's the definitive "is EL hearing me" signal. Right now we have no visibility on whether EL is even processing what we send.

4. **Also: agent never speaks again after greeting.** Even if the user audio is fixed, the bridge sends EL audio to Telnyx but doesn't send Telnyx the `mark` frames EL might be waiting for, and we never send EL `pong` for non-`ping` keepalives. Add `mark` echo and tighten keepalive.

## What to test after deploy

One phone call to the active tenant number. Expected log sequence:
```
Telnyx START
EL ready — agent input format: <X>, output format: <Y>
FIRST caller audio received from Telnyx
FIRST user_audio_chunk sent to EL (format=<X>)
EL VAD score > 0 (← THE critical new line)
user_transcript: "<your words>"
agent_response: "<reply>"
FIRST agent audio sent to Telnyx
```

If VAD never fires, EL still isn't decoding our audio and we'll see the exact format mismatch in the dashboard config log and fix it on the spot.

## Out of scope

Browser widget (already working), webhook routing, Telnyx WebSocket protocol (frames flow correctly), ElevenLabs auth.

Approve and I'll implement, deploy, and we do one phone test.


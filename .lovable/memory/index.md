# Memory: index.md
Updated: just now

# Project Memory

## Core
Voice proto is top priority. Dashboards, CRM (GHL), and telephony (Vapi) are deferred.
UI Aesthetic: Dark, premium, 'luxury' salon feel.
Voice Tech: ElevenLabs Conversational AI (WebRTC). Never use GoHighLevel native voice.
Scripting: No forced hesitations ('uh'). No ellipses; use dashes/commas. No generic affirmations.
Sam's persona, memory, and booking logic must live in project code/backend as the source of truth.

## Memories
- [Persona](mem://features/ai-voice-agent/identity-and-persona) — Relaxed 'laid-back friend' persona without forced hesitations
- [Conversational Logic](mem://features/ai-voice-agent/conversational-logic) — Intent-gated architecture with stage-based goals and semantic acknowledgments
- [Operational Protocols](mem://features/ai-voice-agent/operational-protocols) — Silence nudges, timeouts, and voicemail detection
- [Voice Parameters](mem://features/ai-voice-agent/voice-fine-tuning-parameters) — Stability 0.72, speed 0.95, Flash v2 model settings
- [Voice Architecture](mem://technical/voice-architecture) — WebRTC setup, browser audio unlocks, CORS, and fallback logic
- [GoHighLevel Sync](mem://integrations/gohighlevel-sync) — Hybrid workflow+webhook CRM sync and calendar booking
- [ElevenLabs Config](mem://integrations/elevenlabs-api-configuration) — ELEVENLABS_API_KEY_CUSTOM with convai_* permissions in Supabase
- [Billing Model](mem://business/billing-model) — Agency absorption via GHL SaaS markup for client usage
- [Agent logic source](mem://preferences/agent-logic-source) — Sam's logic and memory must be controlled from backend code, not only dashboard settings
- [Outbound call SIP 487 timeout diagnosis](mem://debugging/outbound-call-failures) — SIP 487 + no call.answered = carrier spam filter on Telnyx DID, NOT a code bug; do not modify dialer code to fix this

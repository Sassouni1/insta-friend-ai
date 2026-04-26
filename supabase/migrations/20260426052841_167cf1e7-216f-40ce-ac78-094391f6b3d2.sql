ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS telnyx_call_session_id text,
  ADD COLUMN IF NOT EXISTS telnyx_call_leg_id text,
  ADD COLUMN IF NOT EXISTS telnyx_answered_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS telnyx_hangup_cause text,
  ADD COLUMN IF NOT EXISTS telnyx_hangup_source text,
  ADD COLUMN IF NOT EXISTS telnyx_sip_code integer,
  ADD COLUMN IF NOT EXISTS telnyx_call_status text,
  ADD COLUMN IF NOT EXISTS telnyx_event_payload jsonb,
  ADD COLUMN IF NOT EXISTS media_frame_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inbound_speech_frame_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_inbound_speech_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_conversations_telnyx_call_control_id
  ON public.conversations (telnyx_call_control_id);

CREATE INDEX IF NOT EXISTS idx_conversations_telnyx_call_session_id
  ON public.conversations (telnyx_call_session_id);
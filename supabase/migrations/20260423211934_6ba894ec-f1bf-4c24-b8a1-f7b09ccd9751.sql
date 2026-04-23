CREATE TABLE public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.transcript_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  text TEXT NOT NULL,
  spoken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transcript_entries_conversation ON public.transcript_entries(conversation_id, spoken_at);
CREATE INDEX idx_conversations_started ON public.conversations(started_at DESC);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read conversations" ON public.conversations FOR SELECT USING (true);
CREATE POLICY "Public can insert conversations" ON public.conversations FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update conversations" ON public.conversations FOR UPDATE USING (true);

CREATE POLICY "Public can read transcript entries" ON public.transcript_entries FOR SELECT USING (true);
CREATE POLICY "Public can insert transcript entries" ON public.transcript_entries FOR INSERT WITH CHECK (true);
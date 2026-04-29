ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_direction_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_direction_check
  CHECK (direction in ('web','inbound','outbound','practice'));

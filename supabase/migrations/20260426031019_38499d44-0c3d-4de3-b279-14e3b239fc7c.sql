
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_tenant_id_fkey,
  ADD CONSTRAINT conversations_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.scheduled_calls
  DROP CONSTRAINT IF EXISTS scheduled_calls_tenant_id_fkey,
  ADD CONSTRAINT scheduled_calls_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_tenant_id_fkey,
  ADD CONSTRAINT bookings_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.phone_numbers
  DROP CONSTRAINT IF EXISTS phone_numbers_tenant_id_fkey,
  ADD CONSTRAINT phone_numbers_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.transcript_entries
  DROP CONSTRAINT IF EXISTS transcript_entries_conversation_id_fkey,
  ADD CONSTRAINT transcript_entries_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;

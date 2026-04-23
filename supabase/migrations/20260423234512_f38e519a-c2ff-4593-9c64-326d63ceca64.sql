
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS ghl_refresh_token text,
  ADD COLUMN IF NOT EXISTS ghl_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS ghl_company_id text,
  ADD COLUMN IF NOT EXISTS oauth_imported boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_ghl_location_id_unique
  ON public.tenants (ghl_location_id)
  WHERE ghl_location_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins manage oauth_states"
ON public.oauth_states
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

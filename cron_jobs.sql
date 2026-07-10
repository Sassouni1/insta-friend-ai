-- Portable pg_cron job definitions exported from Lovable Cloud project
-- Source project ref: quezinwuuxzyqsntzicm
-- Exported: 2026-07-10
--
-- SECRETS ARE REPLACED WITH PLACEHOLDERS. Fill in before running.
--   <NEW_PROJECT_REF>        e.g. abcdefghijklmnop
--   <NEW_ANON_KEY>           new project anon JWT
--
-- Requires extensions: pg_cron, pg_net
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Job 1 of 1
--   jobid (source):   2
--   jobname:          scheduled-call-worker-every-10-min
--   schedule:         */10 * * * *   (every 10 minutes, cluster TZ = UTC)
--   active:           true
--   database:         postgres
--   username:         postgres
--   target:           POST https://<project>.supabase.co/functions/v1/scheduled-call-worker
--   method:           POST
--   headers:          Content-Type: application/json
--                     apikey: <anon JWT>
--                     Authorization: Bearer <anon JWT>
--                   NOTE: the live job does NOT send an `x-worker-secret` header.
--                   `SCHEDULED_CALL_WORKER_SECRET` is unset in the project, so the
--                   worker's optional secret check is skipped (see
--                   supabase/functions/scheduled-call-worker/index.ts lines 8, 16-19).
--                   If you set SCHEDULED_CALL_WORKER_SECRET in the new project,
--                   add: "x-worker-secret": "<WORKER_SECRET>" to the headers below.
--   body:             {}
--   retry behavior:   none (pg_net fires once; failures logged in net._http_response)
-- ---------------------------------------------------------------------------

select cron.schedule(
  'scheduled-call-worker-every-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url    := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/scheduled-call-worker',
    headers:= jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey',        '<NEW_ANON_KEY>',
      'Authorization', 'Bearer <NEW_ANON_KEY>'
      -- ,'x-worker-secret', '<SCHEDULED_CALL_WORKER_SECRET>'  -- add if you set the secret
    ),
    body   := '{}'::jsonb
  ) as request_id;
  $$
);

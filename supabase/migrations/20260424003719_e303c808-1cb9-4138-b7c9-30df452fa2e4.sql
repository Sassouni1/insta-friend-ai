
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

alter table public.tenants add column if not exists webhook_secret text;
update public.tenants set webhook_secret = encode(gen_random_bytes(16), 'hex') where webhook_secret is null;

create table if not exists public.scheduled_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  lead_phone text not null,
  lead_name text,
  lead_email text,
  ghl_contact_id text,
  fire_at timestamptz not null,
  status text not null default 'pending',
  attempts int not null default 0,
  last_error text,
  conversation_id uuid references public.conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scheduled_calls_pending_idx
  on public.scheduled_calls (fire_at)
  where status = 'pending';

alter table public.scheduled_calls enable row level security;

create policy "admins read scheduled_calls"
  on public.scheduled_calls for select to authenticated
  using (has_role(auth.uid(), 'admin'::app_role));

create policy "admins write scheduled_calls"
  on public.scheduled_calls for all to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create trigger scheduled_calls_updated_at
  before update on public.scheduled_calls
  for each row execute function public.update_updated_at_column();

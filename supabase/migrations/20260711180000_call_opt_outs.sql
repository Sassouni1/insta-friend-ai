create table if not exists public.call_opt_outs (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_normalized text not null,
  caller_phone text not null,
  conversation_id uuid references public.conversations(id) on delete set null,
  elevenlabs_conversation_id text,
  reason text,
  source text not null default 'voice_agent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, phone_normalized)
);

create index if not exists call_opt_outs_phone_idx
  on public.call_opt_outs (phone_normalized);

alter table public.call_opt_outs enable row level security;

create policy "admins read call opt outs"
  on public.call_opt_outs for select to authenticated
  using (has_role(auth.uid(), 'admin'::app_role));

create policy "admins write call opt outs"
  on public.call_opt_outs for all to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

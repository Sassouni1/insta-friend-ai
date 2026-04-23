-- Roles infrastructure
create type public.app_role as enum ('admin');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create policy "users read own roles"
  on public.user_roles for select
  to authenticated
  using (user_id = auth.uid());

create policy "admins manage roles"
  on public.user_roles for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Tenants
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ghl_location_id text,
  ghl_api_token text,
  ghl_calendar_id text,
  timezone text not null default 'America/Los_Angeles',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenants enable row level security;

create policy "admins read tenants"
  on public.tenants for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "admins write tenants"
  on public.tenants for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Phone numbers
create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  e164_number text not null unique,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  telnyx_connection_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.phone_numbers enable row level security;

create policy "admins read phone_numbers"
  on public.phone_numbers for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "admins write phone_numbers"
  on public.phone_numbers for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Extend conversations
alter table public.conversations
  add column if not exists tenant_id uuid references public.tenants(id),
  add column if not exists caller_phone text,
  add column if not exists direction text not null default 'web',
  add column if not exists telnyx_call_control_id text;

alter table public.conversations
  add constraint conversations_direction_check
  check (direction in ('web','inbound','outbound'));

-- Bookings
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid references public.conversations(id),
  caller_name text,
  caller_phone text,
  caller_email text,
  slot_iso timestamptz not null,
  ghl_appointment_id text,
  status text not null default 'confirmed',
  created_at timestamptz not null default now()
);

alter table public.bookings enable row level security;

create policy "admins read bookings"
  on public.bookings for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "admins write bookings"
  on public.bookings for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Timestamp trigger function (idempotent)
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger update_tenants_updated_at
  before update on public.tenants
  for each row execute function public.update_updated_at_column();

-- Indexes
create index idx_phone_numbers_tenant on public.phone_numbers(tenant_id);
create index idx_bookings_tenant on public.bookings(tenant_id);
create index idx_conversations_tenant on public.conversations(tenant_id);
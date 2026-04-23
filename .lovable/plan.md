

# Full Build — Steps 1 through 4

Building the complete multi-tenant Telnyx ↔ ElevenLabs ↔ GoHighLevel system in one go. Inbound + outbound calling, real-time GHL booking, admin UI, all wired up.

## Architecture

```text
   Inbound:  PSTN → Telnyx → telnyx-inbound (webhook)
                                  │
                                  │ lookup phone_numbers → tenant
                                  ▼
                            telnyx-bridge (WebSocket)
                            μ-law 8k ⇄ PCM 16k
                                  │
                                  ▼
                            ElevenLabs Sam Agent
                            + dynamic_vars: tenant_id, caller_phone
                                  │
                                  │ server tool calls
                                  ▼
                  ghl-get-availability / ghl-book-appointment
                                  │
                                  ▼
                        Tenant's GHL sub-account

   Outbound: /admin/dial → telnyx-outbound-call
                                  │
                                  │ Telnyx Call Control API
                                  ▼
                            PSTN dial → bridge (same as inbound)
```

## Schema

```sql
create type app_role as enum ('admin');

create table user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);

create function has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = _user_id and role = _role)
$$;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ghl_location_id text,
  ghl_api_token text,           -- encrypted at rest by Postgres
  ghl_calendar_id text,
  timezone text not null default 'America/Los_Angeles',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table phone_numbers (
  id uuid primary key default gen_random_uuid(),
  e164_number text not null unique,
  tenant_id uuid not null references tenants(id) on delete cascade,
  telnyx_connection_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  conversation_id uuid references conversations(id),
  caller_name text,
  caller_phone text,
  caller_email text,
  slot_iso timestamptz not null,
  ghl_appointment_id text,
  status text not null default 'confirmed',
  created_at timestamptz not null default now()
);

alter table conversations
  add column tenant_id uuid references tenants(id),
  add column caller_phone text,
  add column direction text not null default 'web'
    check (direction in ('web','inbound','outbound')),
  add column telnyx_call_control_id text;

-- RLS: admin-only on all new tables, service role bypasses
alter table tenants enable row level security;
alter table phone_numbers enable row level security;
alter table bookings enable row level security;
alter table user_roles enable row level security;

create policy "admins read tenants" on tenants for select to authenticated using (has_role(auth.uid(),'admin'));
create policy "admins write tenants" on tenants for all to authenticated using (has_role(auth.uid(),'admin')) with check (has_role(auth.uid(),'admin'));
-- (same pattern for phone_numbers, bookings)
create policy "users read own roles" on user_roles for select to authenticated using (user_id = auth.uid());
```

## Edge Functions

| Function | Type | Purpose |
|---|---|---|
| `telnyx-inbound` | HTTP | Verify Ed25519 sig → lookup tenant → create conversation row → answer + start media stream |
| `telnyx-bridge` | WebSocket | Bridge Telnyx ⇄ ElevenLabs with μ-law/PCM transcoding + 8k↔16k resampling, persist transcript |
| `telnyx-outbound-call` | HTTP (admin) | Initiate Call Control dial, attach media stream |
| `ghl-get-availability` | HTTP (EL tool) | Load tenant's GHL token, return next 3 open slots in tenant's TZ |
| `ghl-book-appointment` | HTTP (EL tool) | Create contact + appointment in tenant's GHL, insert bookings row |

Shared helpers: `_shared/audio.ts` (μ-law tables + resampler), `_shared/telnyx.ts` (sig verify + Call Control), `_shared/ghl.ts` (GHL v2 API client).

All five get `verify_jwt = false` blocks in `supabase/config.toml` (Telnyx + EL can't send Supabase JWTs; admin-callable ones validate via service role + admin role check).

## Frontend

- **Auth**: email/password sign-in page (`/auth`). First user signs up → manually granted admin role via SQL.
- **`/admin`**: layout with sidebar, gated by `has_role('admin')`.
- **`/admin/tenants`**: CRUD tenants (name, GHL location ID, GHL token, GHL calendar ID, timezone).
- **`/admin/numbers`**: list phone numbers, assign tenant to each.
- **`/admin/bookings`**: table of bookings with tenant/lead/slot/status filters.
- **`/admin/dial`**: paste leads (name + E.164) → trigger outbound calls (rate-limited, max 3 concurrent per tenant).
- Existing `/transcripts` extended with tenant filter + direction badge.

## Sam Prompt Update

Replace "you'll get a booking link" with live booking flow:
- Stage 8 (Scheduling) calls `ghl-get-availability` tool → quotes real times.
- Stage 9 (Confirm) calls `ghl-book-appointment` → confirms appointment ID.
- Inject `tenant_id`, `caller_phone`, `caller_name` as dynamic variables on session start so tools target the right sub-account.

## Secrets to Add

Will request via `add_secret` once you confirm:
- `TELNYX_API_KEY` — Bearer token, Telnyx portal → API Keys
- `TELNYX_PUBLIC_KEY` — Ed25519 public key, Telnyx portal → Webhook signing

Per-tenant GHL tokens live in the `tenants` table (not env vars) so you can scale to N clients without redeploying.

## Manual Telnyx setup (one-time, you do)

1. Buy number(s) in Telnyx portal.
2. Create **Voice API Application** with webhook → `https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/telnyx-inbound`.
3. Assign numbers to that app.
4. Paste API key + public key when prompted.

## Build Order

1. Migration (schema + RLS + roles).
2. Auth + admin gate + `/admin` shell.
3. Tenants/numbers/bookings CRUD pages.
4. Telnyx secrets request.
5. `telnyx-inbound` + `telnyx-bridge` + audio helpers.
6. Sam prompt update + dynamic vars wiring.
7. `ghl-get-availability` + `ghl-book-appointment` (you register them as server tools in EL dashboard after deploy).
8. `telnyx-outbound-call` + `/admin/dial` page.
9. Extend `/transcripts` with tenant/direction filters.

## What you do after I ship

1. Add `TELNYX_API_KEY` + `TELNYX_PUBLIC_KEY` when prompted.
2. Sign up at `/auth`, then I'll grant your user the admin role via SQL.
3. Create your first tenant in `/admin/tenants` (paste GHL location ID, GHL Private Integration token, GHL calendar ID).
4. Configure Telnyx number webhook (link above) and assign in `/admin/numbers`.
5. Register `ghl-get-availability` + `ghl-book-appointment` as server tools in the ElevenLabs agent dashboard (I'll give you the exact JSON schemas).
6. Call your Telnyx number → Sam answers, books live into GHL.

Reply "go" and I'll switch to build mode and ship the whole thing.


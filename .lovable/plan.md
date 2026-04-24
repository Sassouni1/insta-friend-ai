## Goal

Replace the GHL workflow with a native marketplace webhook. New `ghl-contact-webhook` edge function receives `ContactCreate` events directly from GHL, looks up the right tenant (sub-account), checks if the contact already has any appointment, and dials them with Sam — passing the **sub-account's business name** and the **contact's name** so Sam greets them properly.

## How the three requirements map

1. **Per sub-account** → Webhook payload carries `locationId`. We look up the tenant row by `ghl_location_id`. Each sub-account is its own tenant, with its own phone number, calendar, and GHL token. Already how the schema works.
2. **Calls users in that sub-account** → The dial uses `phone_numbers` filtered by that tenant's `tenant_id` (caller-ID = the sub-account's number). Lead phone comes from the contact payload.
3. **Says sub-account name + contact name** → We pass `company` (tenant name) and `name` (contact name) as query params on the bridge WebSocket URL — the bridge already forwards these into Sam's prompt context. (Already wired up in `lead-opt-in-webhook` via `params.set("name", ...)` and `params.set("company", ...)` — we'll mirror that exactly.)

## Files to add / change

### NEW: `supabase/functions/ghl-contact-webhook/index.ts`

Receives the GHL marketplace webhook. Flow:

1. Validate `?secret=<GHL_WEBHOOK_SECRET>` query param.
2. Parse body. Get `type`, `locationId`, and the contact fields (GHL marketplace events typically nest contact fields at the root, e.g. `{ type, locationId, id, firstName, lastName, phone, email, ... }` for `ContactCreate`).
3. If `type !== "ContactCreate"` → return 200 `{ ignored: type }`.
4. Look up tenant by `ghl_location_id = locationId`. If missing/inactive → 200 `{ ignored }`.
5. Extract phone. If missing, fetch the contact via GHL API as a fallback. Still missing → 200.
6. **Booked-check**: GET `/contacts/{contactId}/appointments` with the tenant's fresh token. If any appointment row exists (any status, any calendar) → 200 `{ skipped: "already booked" }`.
7. **Dedupe**: skip if a `scheduled_calls` row exists for same `tenant_id + lead_phone` in the last 24h (stops repeated webhook fires).
8. Insert `scheduled_calls` row with `fire_at = now + 120s`, `lead_name`, `lead_email`, `ghl_contact_id`.
9. Schedule background dial via `EdgeRuntime.waitUntil` — uses shared dialer module that passes `name` (contact) + `company` (tenant.name) + `tz` to the bridge so Sam introduces himself properly.

### NEW: `supabase/functions/_shared/dialer.ts`

Extract the `placeDial` + retry + `wasAnswered` + `fireCall` logic out of `lead-opt-in-webhook/index.ts` so both webhooks share it. The contact name and tenant name flow through the bridge URL params exactly as today — no behavior change for inbound or for the existing webhook.

### EDIT: `supabase/functions/_shared/ghl.ts`

Add three things:

- `getFreshGhlToken(supabase, tenantId)` — reads tenant row, refreshes via `POST /oauth/token` with `grant_type=refresh_token` if `ghl_token_expires_at` is within 5 min, persists the new token + expiry, returns the access token. Uses `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` (already configured).
- `GhlClient.getContact(contactId)` — `GET /contacts/{contactId}`.
- `GhlClient.getContactAppointments(contactId)` — `GET /contacts/{contactId}/appointments`.

### EDIT: `supabase/functions/lead-opt-in-webhook/index.ts`

Refactor to import `placeDial` / `fireCall` from the new `_shared/dialer.ts`. No external behavior change. Kept as a fallback path.

### EDIT: `supabase/config.toml`

Append:
```toml
[functions.ghl-contact-webhook]
verify_jwt = false
```

## What you'll do in GHL (one time, in your marketplace app config)

After deploy, paste this URL into your GHL marketplace app's webhook settings:

```
https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/ghl-contact-webhook?secret=<GHL_WEBHOOK_SECRET>
```

Subscribed events: `ContactCreate` (you can leave `ContactUpdate` subscribed — we just ignore it).

Once installed on a sub-account, every new contact in that sub-account flows through this URL automatically. No per-sub-account workflow needed.

## Secret needed

I'll request `GHL_WEBHOOK_SECRET` (any random string of your choice, e.g. a UUID). This locks the webhook URL so randoms can't POST to it.

## Sam's greeting

Already handled by the bridge — when the call connects, Sam gets `company=<tenant.name>` and `name=<contact firstName>` injected into his system prompt context. Example greeting:

> "Hey {name}, this is Sam over at {company} — saw you just opted in, figured I'd give you a quick ring."

If you want me to also tighten up the exact greeting line in the bridge prompt, say the word and I'll adjust it in the same pass.

## Risks

- **GHL payload shape**: marketplace `ContactCreate` events sometimes flatten fields and sometimes nest under `contact`. Function will check both shapes (`body.phone || body.contact?.phone`, etc.) — same defensive parsing as the existing webhook.
- **Refresh token revoked**: if a sub-account uninstalls the app, refresh fails. We log to `scheduled_calls.last_error`, mark `failed`, and move on. No crash, no retry storm.
- **Contact created without phone** (e.g. email-only opt-in): we return 200 with `ignored: no phone`. No dial attempted.

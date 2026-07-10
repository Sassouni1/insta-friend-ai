# MIGRATION HANDOFF — Hair System Dialer

**From:** Lovable Cloud project `quezinwuuxzyqsntzicm` (Lovable project ID `cd1210a7-e5fa-4f39-b711-4798300aaa63`)
**GitHub:** https://github.com/Sassouni1/insta-friend-ai
**Source commit captured:** `3f6aaaa64b35f19dae5fb3af7e8afca7891d134c` ("Identified deprecated OmniVoice")
**Date:** 2026-07-10
**Nothing was paused, redeployed, rotated, or published. No calls were placed.**

---

## 1. Artifact locations

| Artifact | Location | Status |
|---|---|---|
| Source ZIP (frontend + `supabase/` + migrations + config + lockfiles) | `hair-system-dialer-source-2026-07-10.zip` (in this download panel) | ✅ Created |
| Portable cron definitions | `cron_jobs.sql` (in this download panel) | ✅ Created |
| Secret & env inventory | `SECRET_AND_ENVIRONMENT_INVENTORY.md` (in this download panel and in repo root) | ✅ Created |
| **Database export (schema + data + auth users/identities)** | **EXPORT INCOMPLETE — see §2** | ⚠️ Manual step required |
| **GitHub branch `lovable-cloud-export-2026-07-10`** | **EXPORT INCOMPLETE — see §3** | ⚠️ Manual step required |
| Storage buckets | None exist in project (verified) | ✅ N/A |

The source ZIP contains ALL 20 edge functions plus `_shared/`, every migration under `supabase/migrations/`, `supabase/config.toml`, `package.json`, `bun.lockb`/`package-lock.json`, Vite/Tailwind/TS config, and the full React frontend. It does **NOT** contain `.env`, database data, or auth users — those are handled in §2.

---

## 2. Database export — EXPORT INCOMPLETE

**Exact manual action Chris must perform:**

1. In the Lovable editor, open **Cloud → Advanced settings → Export data**.
2. Click **Export**. Lovable prepares the archive server-side and notifies when ready.
3. Download the resulting archive from that same panel. It contains:
   - All `public` schema tables (bookings, conversations, oauth_states, phone_numbers, scheduled_calls, tenants, transcript_entries, user_roles), columns, types, defaults, PK/FK, indexes, constraints, enums, functions (`has_role`, `update_updated_at_column`), triggers, RLS policies, views, and current row data — including tenants, phone number config, GHL OAuth tokens, calendars, conversations, transcripts, scheduled calls, bookings, and user_roles.
   - `auth.users` and `auth.identities` (see §4 for what does and does not transfer).

The Lovable agent cannot trigger this export via tools; it is a UI-only action. **Do NOT store this file in GitHub** — it contains OAuth tokens and PII.

---

## 3. Source delivery — GitHub branch NOT created

The Lovable agent is prohibited from running stateful git commands (checkout/push/branch). Deliver via one of these two Chris-driven options:

**Option A (ZIP — already done):** Distribute `hair-system-dialer-source-2026-07-10.zip` from this download panel.

**Option B (Branch — Chris runs locally):**
```bash
git clone https://github.com/Sassouni1/insta-friend-ai.git
cd insta-friend-ai
git fetch origin
git checkout -b lovable-cloud-export-2026-07-10 3f6aaaa64b35f19dae5fb3af7e8afca7891d134c
git push -u origin lovable-cloud-export-2026-07-10
```
`main` is untouched by this operation.

Any Lovable changes ahead of GitHub `main` are captured in the ZIP; the current sandbox HEAD is `3f6aaaa`.

---

## 4. Authentication export — status & limitations

Included in the Cloud database export (§2):
- `auth.users` rows (id, email, phone, created_at, metadata, email_confirmed_at, etc.)
- `auth.identities` rows (provider linkages)
- **Password hashes (`encrypted_password`)** — transferable if the export preserves the `auth` schema dump. Users will retain their passwords on the new project.

CANNOT be transferred:
- **Active sessions / refresh tokens** — users must sign in again after cutover.
- **The old project's JWT signing secret** — new project mints new tokens, so all outstanding JWTs are invalidated (expected).
- **MFA factor secrets** encrypted with the old project's `auth.jwt_secret` will not decrypt on the new project; MFA-enrolled users must re-enroll.

If the Cloud export archive omits `auth.*`, the fallback is a `pg_dump --schema=auth` on the new project — this is not currently possible from the Lovable agent (no dashboard access, service role key unavailable on Lovable Cloud). Chris would need to open a Lovable support ticket for a raw `auth` dump.

---

## 5. Storage buckets

Verified via project inspection: **zero storage buckets configured**. No storage export required.

---

## 6. Cron / scheduled jobs — LIVE configuration

Captured directly from `cron.job` in the live database.

| Field | Value |
|---|---|
| jobid (source) | 2 |
| jobname | `scheduled-call-worker-every-10-min` |
| schedule | `*/10 * * * *` (every 10 minutes) |
| timezone | Cluster default (UTC) |
| active | true |
| database / user | postgres / postgres |
| target URL | `https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/scheduled-call-worker` |
| HTTP method | POST |
| headers | `Content-Type: application/json`, `apikey: <anon JWT>`, `Authorization: Bearer <anon JWT>` |
| body | `{}` |
| retry behavior | None — `pg_net.http_post` fires once; response rows land in `net._http_response` |
| auth to worker | **No `x-worker-secret` header is sent.** `SCHEDULED_CALL_WORKER_SECRET` is unset in Lovable secrets, so the worker's optional check (`if (WORKER_SECRET) { ... }` at `scheduled-call-worker/index.ts:16-19`) is skipped. The `apikey`/`Authorization` anon JWT satisfies Supabase's function gateway, and the worker's own logic accepts the call. |

There is **no** `scheduled-calls-worker` (plural) function or cron entry — the source has only `scheduled-call-worker` (singular). The plural name in the request appears to be a typo; only one worker exists.

Portable job definition with placeholders: `cron_jobs.sql`.

---

## 7. Deployed edge functions (20 total — full source in ZIP)

Requested list was 21 items but duplicates a nonexistent `scheduled-calls-worker`. Actual deployed set:

| Function | `verify_jwt` | Required env vars (see full inventory for detail) |
|---|---|---|
| admin-create-user | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| crm-contact-webhook | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| crm-oauth-callback | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET` |
| crm-oauth-start | true (default) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_CLIENT_ID` |
| elevenlabs-conversation-token | true (default) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ELEVENLABS_API_KEY_CUSTOM` (fallback `ELEVENLABS_API_KEY`), optional `ELEVENLABS_AGENT_ID` |
| ghl-book-appointment | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET` |
| ghl-calendar-tool | false | same as above |
| ghl-get-availability | false | same as above |
| ghl-list-calendars | true (default) | same as above |
| ghl-list-contacts-debug | false | same as above |
| ghl-test-contact-debug | false | same as above |
| lead-opt-in-webhook | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| practice-bot-call | false | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELNYX_API_KEY` |
| scheduled-call-worker | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional `SCHEDULED_CALL_WORKER_SECRET` |
| telnyx-bridge | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ELEVENLABS_API_KEY_CUSTOM`, optional `ELEVENLABS_AGENT_ID`, `PRACTICE_CHRIS_AGENT_ID`, `PRACTICE_CHRIS_VOICE_ID` |
| telnyx-call-debug | true (default) | `TELNYX_API_KEY` |
| telnyx-inbound | false | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_API_KEY` |
| telnyx-outbound-call | true (default) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELNYX_API_KEY` |
| **telnyx-bridge-omnivoice** ⚠️ | false | **DEPRECATED SANDBOX — DO NOT DEPLOY.** Uses `OMNIVOICE_*` secrets. |
| **telnyx-outbound-call-omnivoice** ⚠️ | false | **DEPRECATED SANDBOX — DO NOT DEPLOY.** |

Production path: `telnyx-outbound-call → telnyx-bridge → ElevenLabs`. OmniVoice functions are kept in the archive for historical completeness only.

---

## 8. Secret names to recreate manually in the new project

Full detail in `SECRET_AND_ENVIRONMENT_INVENTORY.md`. Short list:

**Auto-provided by any new Supabase project — do nothing:**
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEY(S)`, `SUPABASE_SECRET_KEYS`, `SUPABASE_DB_URL`, and the frontend `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PROJECT_ID`.

**Must be manually recreated (values not exportable):**
- `TELNYX_API_KEY`
- `TELNYX_PUBLIC_KEY`
- `ELEVENLABS_API_KEY_CUSTOM` *(the connector-managed `ELEVENLABS_API_KEY` will not follow — provision `_CUSTOM` explicitly)*
- `GHL_CLIENT_ID`
- `GHL_CLIENT_SECRET`

**Generate fresh random & wire into cron:**
- `SCHEDULED_CALL_WORKER_SECRET` (currently unset — optional, but recommended)

**Optional overrides (only if you were relying on them; currently unset in Lovable):**
- `ELEVENLABS_AGENT_ID`, `PRACTICE_CHRIS_AGENT_ID`, `PRACTICE_CHRIS_VOICE_ID`

**DO NOT recreate (deprecated sandbox):**
- `OMNIVOICE_TTS_ENABLED`, `OMNIVOICE_TTS_URL`, `OMNIVOICE_INSTRUCT`, `OMNIVOICE_NUM_STEP`, `OMNIVOICE_TIMEOUT_MS`, `OMNIVOICE_AGENT_KINDS`, `ELEVENLABS_AGENT_MUTATION_ENABLED`.

**Cannot export:**
- `LOVABLE_API_KEY` (Lovable-managed; the new Lovable project auto-provisions its own if you use Lovable AI Gateway).

---

## 9. Every occurrence of the old reference `quezinwuuxzyqsntzicm`

Full-repo scan of source (excluding `node_modules`, `.git`, `dist`):

| File | Line(s) | Purpose | Action |
|---|---|---|---|
| `.env` | 1, 3 | `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL` | Auto-regenerated by new Supabase/Lovable Cloud connection. Do NOT hand-edit if using Lovable Cloud. |
| `supabase/config.toml` | 1 | `project_id = "quezinwuuxzyqsntzicm"` | Auto-regenerated when the CLI is linked to the new project. |
| `src/pages/OAuthCallback.tsx` | 10 | Hard-coded GHL OAuth callback URL sent to GoHighLevel | **Manual edit required** — replace with new project ref, then update the callback URL registered in the GoHighLevel Marketplace app. |
| `SECRET_AND_ENVIRONMENT_INVENTORY.md` | multiple | Documentation only | No action. |
| `cron.job` (DB) | job 2 command body | Live cron target URL | Recreated from `cron_jobs.sql` with new ref. |

Additionally, the following live systems reference the old project host and must be updated **outside** the codebase:
- **Telnyx inbound webhook URL** — currently `https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/telnyx-inbound`. Update in the Telnyx Portal → Voice → Programmable Voice → Applications for every configured connection.
- **Telnyx media streaming URL** — built at dial time as `wss://quezinwuuxzyqsntzicm.functions.supabase.co/telnyx-bridge`. Automatically switches when `SUPABASE_URL` changes in `telnyx-outbound-call/index.ts`. Verify after cutover.
- **GoHighLevel OAuth redirect URL** — currently `https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/crm-oauth-callback`. Re-register the new callback in the GHL app; existing OAuth tokens continue to refresh via stored `refresh_token` values migrated with the DB.
- **GHL webhook URLs** (`lead-opt-in-webhook`, `crm-contact-webhook`) — update in any GHL workflows or third-party senders that POST to the old host.
- **Frontend URLs / auth redirects / allowed origins:** preview `https://id-preview--cd1210a7-e5fa-4f39-b711-4798300aaa63.lovable.app`, published `https://insta-friend-ai.lovable.app`, custom domain `https://contact.menshairexpert.com`. Reconfigure the new project's Auth → URL Configuration accordingly.
- **ElevenLabs agent tool URLs** — any agent tool pointing at `https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/...` (e.g. `ghl-calendar-tool`, `ghl-get-availability`, `ghl-book-appointment`) must be updated in the ElevenLabs Agent dashboard. These live in ElevenLabs config, not in this repo.

---

## 10. Live source vs GitHub `main`

The sandbox HEAD `3f6aaaa` is the source of truth for this export. If `main` on GitHub is behind, use the ZIP or Option B in §3 to bring the new project's repo current. The Lovable agent did not push, deploy, or modify `main` during this handoff.

---

## 11. Safety confirmation

- No Cloud pause or removal.
- No database rows changed.
- No secrets added, rotated, or deleted.
- No functions deployed or redeployed.
- No frontend publish.
- No calls placed.
- No webhook or DNS changes.
- No migration performed.
- `main` untouched.

**Only artifact creation was performed.**

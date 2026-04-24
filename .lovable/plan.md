# Plan — Verify, then fix (no more blind patches)

## Why we are not implementing Manus's three changes as-written

I read the current `telnyx-bridge/index.ts` line by line and queried the database. Here is what is actually true:

1. **Voice ID `UgBBYS2sOqTuMpoF3BR0` does not exist in our code.** Not in `telnyx-bridge`, not anywhere. Voice selection lives inside the ElevenLabs agent config (server-side at EL). Removing a string that isn't there changes nothing.

2. **The `conversations` row is created by `telnyx-inbound` *before* Telnyx ever connects to `telnyx-bridge`.** The conversation_id is passed in the WebSocket URL as `?conv=<uuid>`. An "insert with ON CONFLICT DO NOTHING on conversation_id" inside `telnyx-bridge` would conflict on every single call and reject 100% of traffic.

3. **The "two booted entries racing on the signed URL" claim cannot be verified.** Live edge function logs return empty for both `telnyx-bridge` and `telnyx-inbound`, and the database has zero inbound conversations. Manus is reasoning from logs that aren't in the current system — possibly from an older deploy or a different session.

The dedup *idea* (concurrent webhooks for the same call) is sound. But the proposed mechanism is wrong for our architecture, and the voice ID claim is fabricated.

## What we will do instead (3 steps, in order, no code changes until step 2)

### Step 1 — Capture one fresh inbound test call

Chris places a single test call to the Telnyx number. Right after, we pull:

- `telnyx-inbound` logs for that call window
- `telnyx-bridge` logs for that call window
- The `conversations` row(s) created
- The `streaming.failed` payload (if any) from Telnyx

Goal: see *with current deployed code* whether we have:
- (a) Duplicate inbound webhooks (Manus's race theory) → multiple `conversations` rows with same `telnyx_call_control_id`
- (b) Single webhook but bridge never reached → URL/handshake problem
- (c) Bridge reached, EL closes early → real EL-side problem (codec, signed URL reuse, etc.)

These three failure modes need three completely different fixes. We are not picking a fix until we know which one we have.

### Step 2 — Fix exactly what step 1 reveals

Branch on the evidence:

**If (a) duplicate webhooks:** Add dedup in `telnyx-inbound` keyed on `call_control_id` (this part of Manus's plan is correct in principle; just needs to live in `telnyx-inbound`, not `telnyx-bridge`, and key on `telnyx_call_control_id` — which the table already has as a column).

**If (b) bridge never reached:** Examine the exact `stream_url` Telnyx logs in `streaming.failed` and the WS upgrade response. Likely fix is in `telnyx-inbound` URL builder.

**If (c) EL closes early:** Look at the EL `onclose` code/reason logged by the bridge. Could be agent config, signed URL TTL, or codec mismatch on the EL side.

### Step 3 — Re-test and confirm

Place one more test call. Success = `[bridge xxx] FIRST agent audio sent to Telnyx` appears in logs and Chris hears the greeting.

## What Chris needs to do

Place one inbound test call to the Telnyx number when ready. That's it. Then approve this plan so I can pull the fresh logs in default mode and act on real evidence.

## Technical notes

- `telnyx-bridge/index.ts` currently has no voice ID — voice is set in the EL agent dashboard.
- `conversations.telnyx_call_control_id` column already exists, so dedup on it requires no migration.
- Live logs are currently empty, which itself is informative — either no inbound calls have been attempted recently, or log retention has rolled.

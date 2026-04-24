

## Telnyx audit results — what changed and what's left

Manus's report changes the diagnosis. Two big new facts:

1. **The number wasn't even attached to Command IQ.** That alone explains "could not be completed as dialed" and the silent inbound calls. Now fixed.
2. **Codecs are fine, outbound profile is fine, webhook URL is correct.** So the portal side is now clean except for one thing to verify.

## Action items

### A. Verify the Telnyx public key matches (you, 30 seconds)
The `TELNYX_PUBLIC_KEY` secret in our backend must equal exactly:
`P7aSLLNE0EQHoGUmgQkO5ZbF7t2rrn9oRNzEHDyMejM=`

If it doesn't match, every Telnyx webhook is silently rejected as "invalid signature" and nothing in `telnyx-inbound` runs past the verification gate. I'll check this and update the secret if needed once we go to default mode.

### B. Code fixes (I implement)
The Manus note about media streaming is important: streaming is started either via the `answer` Call Control command (inbound — we already do this) or via `stream_url` on dial (outbound — we already do this). So no new portal config is needed, but our bridge code still has real bugs:

**Files to update:**

1. `supabase/functions/_shared/telnyx.ts`
   - Add `stream_bidirectional_mode` and `stream_bidirectional_codec` parameters to `telnyxDial`.

2. `supabase/functions/lead-opt-in-webhook/index.ts`
   - Pass `stream_bidirectional_mode: "rtp"` and `stream_bidirectional_codec: "PCMU"` on dial.

3. `supabase/functions/telnyx-outbound-call/index.ts`
   - Same bidirectional params on dial.

4. `supabase/functions/telnyx-inbound/index.ts`
   - Already sets `stream_bidirectional_mode: "rtp"` and `stream_codec: "PCMU"` on answer — leave as-is.

5. `supabase/functions/telnyx-bridge/index.ts`
   - **Remove `stream_id` from outbound `media` and `clear` frames** sent to Telnyx (Telnyx spec doesn't include it on agent→Telnyx frames; very likely cause of `streaming.failed`).
   - Don't push agent audio to Telnyx until the `start` frame arrives.
   - Add deep diagnostic logging: every Telnyx event (`connected`, `start`, `media` count, `stop`, `error` payload), every ElevenLabs lifecycle event, and explicit "first caller audio in" / "first agent audio out" markers.

### C. Verify and re-test
1. Confirm/update `TELNYX_PUBLIC_KEY` secret.
2. Deploy the updated edge functions.
3. Trigger one outbound call to `+17276374672`.
4. Read logs and confirm this sequence:
   - `call.initiated` → `call.answered` → `streaming.started` (no `streaming.failed`)
   - bridge logs: `Telnyx start frame received` → `first caller audio` → `first agent audio sent`
   - transcript_entries rows appear

## Why this should finally work
- The "could not be completed as dialed" error is explained by the unassigned number — now fixed.
- The silent calls + `streaming.failed` pattern is explained by malformed outbound frames + missing bidirectional flag — fixed by code changes above.
- New logs will pinpoint anything still broken in one specific layer instead of guessing.

Approve and I'll implement immediately.


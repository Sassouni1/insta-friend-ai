# Apply practice-direction migration + first live test

## What this does

1. **Run the migration** to allow `conversations.direction = 'practice'`:
   ```sql
   ALTER TABLE public.conversations
     DROP CONSTRAINT IF EXISTS conversations_direction_check;
   ALTER TABLE public.conversations
     ADD CONSTRAINT conversations_direction_check
     CHECK (direction in ('web','inbound','outbound','practice'));
   ```

2. **Verify** the new constraint is live by querying `pg_constraint`.

3. **Smoke-test** that an insert with `direction='practice'` is now accepted (insert a throwaway row, confirm it lands, then delete it via a follow-up migration if needed — or just leave it; it's harmless).

4. **Hand off for the live test**: tell you to open `/admin/practice` and click **Start Chris calling Sam**.

5. **Tail logs live** from both edge functions while the call runs:
   - `practice-bot-call` — confirms the outbound dial to Sam's DID was issued
   - `telnyx-bridge` — confirms the Chris leg (`bot=chris`) connected, audio frames flowed, and ElevenLabs negotiated formats correctly

## What I'll be watching for in logs

- `practice-bot-call`: 200 response, Telnyx `call_control_id` returned, no auth errors
- `telnyx-bridge` Chris leg: `START stream_id=…`, `EL ready`, `FIRST user_audio_chunk sent to EL`, `FIRST agent audio sent to Telnyx`, `vad_score`
- `telnyx-bridge` Sam leg: same sequence on the inbound side
- Any `SIP 487 / timeout` or EL close codes get flagged immediately

## Already done (from previous turn)

- ✅ `practice-bot-call` deployed
- ✅ `telnyx-bridge` redeployed with `bot=chris` branch (verified line 131, 191, 249)
- ✅ `supabase/config.toml` has `[functions.practice-bot-call] verify_jwt = false`
- ✅ Secrets present: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `ELEVENLABS_API_KEY_CUSTOM`

## Only blocker

The migration file was pushed via GitHub but Lovable's auto-sync only deploys edge functions, not migrations from the repo. I need build-mode access to run the SQL — that's it.

Approve this and I'll run the migration, verify, then green-light you to click the button.

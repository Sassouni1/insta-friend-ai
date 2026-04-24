import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxDial } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 10;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: due, error } = await supabase
    .from("scheduled_calls")
    .select("id, tenant_id, lead_phone, lead_name, attempts")
    .eq("status", "pending")
    .lte("fire_at", new Date().toISOString())
    .order("fire_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[worker] query failed", error);
    return jsonResponse({ error: error.message }, 500);
  }

  if (!due || due.length === 0) {
    return jsonResponse({ ok: true, processed: 0 });
  }

  let dialed = 0;
  let failed = 0;

  for (const call of due) {
    // Mark in-progress to avoid double-dial if the cron overlaps
    await supabase
      .from("scheduled_calls")
      .update({ status: "processing", attempts: call.attempts + 1 })
      .eq("id", call.id)
      .eq("status", "pending");

    try {
      const { data: phoneRow } = await supabase
        .from("phone_numbers")
        .select("e164_number, telnyx_connection_id")
        .eq("tenant_id", call.tenant_id)
        .eq("active", true)
        .limit(1)
        .maybeSingle();

      if (!phoneRow?.e164_number || !phoneRow?.telnyx_connection_id) {
        throw new Error("no active phone number for tenant");
      }

      const { data: convRow, error: convErr } = await supabase
        .from("conversations")
        .insert({
          tenant_id: call.tenant_id,
          caller_phone: call.lead_phone,
          direction: "outbound",
        })
        .select("id")
        .single();

      if (convErr || !convRow) throw new Error(`conversation insert failed: ${convErr?.message}`);

      const streamUrl =
        `${BRIDGE_WS_URL}?conv=${convRow.id}&tenant=${call.tenant_id}&caller=${encodeURIComponent(call.lead_phone)}` +
        (call.lead_name ? `&name=${encodeURIComponent(call.lead_name)}` : "");

      const dialRes = await telnyxDial({
        to: call.lead_phone,
        from: phoneRow.e164_number,
        connection_id: phoneRow.telnyx_connection_id,
        stream_url: streamUrl,
        stream_track: "both_tracks",
      });

      if (!dialRes.ok) {
        const txt = await dialRes.text();
        throw new Error(`telnyx dial ${dialRes.status}: ${txt.slice(0, 200)}`);
      }

      const dialData = await dialRes.json();
      const callControlId = dialData?.data?.call_control_id;

      if (callControlId) {
        await supabase
          .from("conversations")
          .update({ telnyx_call_control_id: callControlId })
          .eq("id", convRow.id);
      }

      await supabase
        .from("scheduled_calls")
        .update({ status: "dialed", conversation_id: convRow.id, last_error: null })
        .eq("id", call.id);

      dialed++;
    } catch (err: any) {
      failed++;
      const msg = err?.message || String(err);
      console.error(`[worker] call ${call.id} failed:`, msg);
      const nextStatus = call.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending";
      const retryAt = nextStatus === "pending" ? new Date(Date.now() + 60_000).toISOString() : undefined;
      await supabase
        .from("scheduled_calls")
        .update({
          status: nextStatus,
          last_error: msg.slice(0, 500),
          ...(retryAt ? { fire_at: retryAt } : {}),
        })
        .eq("id", call.id);
    }
  }

  return jsonResponse({ ok: true, processed: due.length, dialed, failed });
});

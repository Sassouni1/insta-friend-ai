import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxCallControl, verifyTelnyxSignature } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_PUBLIC_KEY = Deno.env.get("TELNYX_PUBLIC_KEY") || "";

const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const rawBody = await req.text();

  // Verify Telnyx signature (skip if no public key configured — dev/testing fallback)
  if (TELNYX_PUBLIC_KEY) {
    const sig = req.headers.get("telnyx-signature-ed25519");
    const ts = req.headers.get("telnyx-timestamp");
    const ok = await verifyTelnyxSignature(rawBody, sig, ts, TELNYX_PUBLIC_KEY);
    if (!ok) {
      console.error("[telnyx-inbound] signature verification failed");
      return jsonResponse({ error: "invalid signature" }, 401);
    }
  } else {
    console.warn("[telnyx-inbound] TELNYX_PUBLIC_KEY not set — skipping signature verification");
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }

  const eventType = event?.data?.event_type;
  const payload = event?.data?.payload || {};
  console.log(`[telnyx-inbound] event: ${eventType}`);

  // Only act on call.initiated for inbound calls
  if (eventType !== "call.initiated" || payload.direction !== "incoming") {
    return jsonResponse({ ok: true, ignored: eventType });
  }

  const callControlId: string = payload.call_control_id;
  const toNumber: string = payload.to;
  const fromNumber: string = payload.from;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Look up tenant by dialed number
  const { data: phoneRow, error: phoneErr } = await supabase
    .from("phone_numbers")
    .select("tenant_id, active")
    .eq("e164_number", toNumber)
    .maybeSingle();

  if (phoneErr || !phoneRow || !phoneRow.active) {
    console.error(`[telnyx-inbound] no tenant for ${toNumber}`, phoneErr);
    // Hangup gracefully
    await telnyxCallControl(callControlId, "hangup", {});
    return jsonResponse({ ok: false, reason: "no tenant" });
  }

  // Create conversation row
  const { data: convRow, error: convErr } = await supabase
    .from("conversations")
    .insert({
      tenant_id: phoneRow.tenant_id,
      caller_phone: fromNumber,
      direction: "inbound",
      telnyx_call_control_id: callControlId,
    })
    .select("id")
    .single();

  if (convErr) {
    console.error("[telnyx-inbound] failed to create conversation:", convErr);
    await telnyxCallControl(callControlId, "hangup", {});
    return jsonResponse({ ok: false, reason: "db error" });
  }

  const streamUrl = `${BRIDGE_WS_URL}?conv=${convRow.id}&tenant=${phoneRow.tenant_id}&caller=${encodeURIComponent(fromNumber)}`;

  // Answer the call with media streaming
  const answerRes = await telnyxCallControl(callControlId, "answer", {
    stream_url: streamUrl,
    stream_track: "both_tracks",
    stream_bidirectional_mode: "rtp",
    stream_codec: "PCMU",
  });

  if (!answerRes.ok) {
    const txt = await answerRes.text();
    console.error(`[telnyx-inbound] answer failed [${answerRes.status}]: ${txt}`);
  }

  return jsonResponse({ ok: true, conversation_id: convRow.id });
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxCallControl, verifyTelnyxSignature } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_PUBLIC_KEY = Deno.env.get("TELNYX_PUBLIC_KEY") || "";

const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

async function findRecentPracticeAnswer(
  supabase: ReturnType<typeof createClient>,
  fromNumber: string,
  toNumber: string,
) {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, tenant_id, telnyx_event_payload, started_at")
    .eq("direction", "practice")
    .gte("started_at", fiveMinutesAgo)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[telnyx-inbound] practice lookup failed", error);
    return null;
  }

  return (data || []).find((row: any) => {
    const meta = row.telnyx_event_payload || {};
    return meta.practice_mode === "sam_to_chris" &&
      meta.practice_answer_bot === "chris" &&
      meta.practice_from_number === fromNumber &&
      meta.practice_target_number === toNumber;
  }) || null;
}

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
  const callControlIdFromEvent = payload.call_control_id;
  const callSessionIdFromEvent = payload.call_session_id;

  if (eventType && callControlIdFromEvent && eventType !== "call.initiated") {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("telnyx_event_payload")
      .eq("telnyx_call_control_id", callControlIdFromEvent)
      .maybeSingle();
    const existingPayload = (existingConv?.telnyx_event_payload || {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {
      telnyx_call_status: eventType,
      telnyx_event_payload: existingPayload.practice_mode
        ? { ...existingPayload, last_telnyx_event_type: eventType, last_telnyx_payload: payload }
        : payload,
    };
    if (callSessionIdFromEvent) update.telnyx_call_session_id = callSessionIdFromEvent;
    if (payload.call_leg_id) update.telnyx_call_leg_id = payload.call_leg_id;
    if (eventType === "call.answered") update.telnyx_answered_at = new Date().toISOString();
    if (eventType === "call.hangup") {
      update.telnyx_hangup_cause = payload.hangup_cause || payload.cause || null;
      update.telnyx_hangup_source = payload.hangup_source || null;
      update.telnyx_sip_code = payload.sip_hangup_cause || payload.sip_code || payload.sip_response_code || null;
      console.log(
        `[telnyx-inbound] hangup outcome to=${payload.to || "-"} from=${payload.from || "-"} cause=${update.telnyx_hangup_cause || "-"} sip=${update.telnyx_sip_code || "-"}`,
      );
    }
    await supabase.from("conversations").update(update).eq("telnyx_call_control_id", callControlIdFromEvent);
  }

  // Log full payload of streaming.failed so we can see exactly what Telnyx is rejecting.
  if (eventType === "streaming.failed") {
    console.error(`[telnyx-inbound] streaming.failed payload: ${JSON.stringify(payload)}`);
  }

  // Only act on call.initiated for inbound calls
  if (eventType !== "call.initiated" || payload.direction !== "incoming") {
    return jsonResponse({ ok: true, ignored: eventType });
  }

  const callControlId: string = payload.call_control_id;
  const toNumber: string = payload.to;
  const fromNumber: string = payload.from;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const practiceAnswer = await findRecentPracticeAnswer(supabase, fromNumber, toNumber);

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

  const practiceMetadata = (practiceAnswer?.telnyx_event_payload || {}) as Record<string, unknown>;
  const answerBot = practiceAnswer ? "chris" : "sam";
  const conversationDirection = practiceAnswer ? "practice" : "inbound";
  const conversationInsert: Record<string, unknown> = {
    tenant_id: phoneRow.tenant_id,
    caller_phone: fromNumber,
    direction: conversationDirection,
    telnyx_call_control_id: callControlId,
  };
  if (practiceAnswer) {
    conversationInsert.agent_id = "practice_chris";
    conversationInsert.telnyx_event_payload = {
      practice_mode: "sam_to_chris",
      practice_bot: "chris",
      practice_parent_conversation_id: practiceAnswer.id,
      practice_target_number: toNumber,
      practice_from_number: fromNumber,
      practice_script: practiceMetadata.practice_script,
    };
  }

  // Create conversation row
  const { data: convRow, error: convErr } = await supabase
    .from("conversations")
    .insert(conversationInsert)
    .select("id")
    .single();

  if (convErr) {
    console.error("[telnyx-inbound] failed to create conversation:", convErr);
    await telnyxCallControl(callControlId, "hangup", {});
    return jsonResponse({ ok: false, reason: "db error" });
  }

  const { data: tenantRow } = await supabase
    .from("tenants")
    .select("name, timezone")
    .eq("id", phoneRow.tenant_id)
    .maybeSingle();

  const streamParams = new URLSearchParams({
    conv: convRow.id,
    tenant: phoneRow.tenant_id,
    caller: fromNumber,
    bot: answerBot,
    direction: conversationDirection,
  });
  if (answerBot === "chris") streamParams.set("name", "Chris");
  if (tenantRow?.name) streamParams.set("company", tenantRow.name);
  if (tenantRow?.timezone) streamParams.set("tz", tenantRow.timezone);
  const streamUrl = `${BRIDGE_WS_URL}?${streamParams.toString()}`;

  // Answer with WebSocket bidirectional streaming. inbound_track = caller's mic only.
  // We send TTS back via WS `media` frames; bidirectional_mode=rtp is required for
  // Telnyx to accept and play those frames on the call leg.
  const answerRes = await telnyxCallControl(callControlId, "answer", {
    stream_url: streamUrl,
    stream_track: practiceAnswer ? "both_tracks" : "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
  });

  if (!answerRes.ok) {
    const txt = await answerRes.text();
    console.error(`[telnyx-inbound] answer failed [${answerRes.status}]: ${txt}`);
  }

  return jsonResponse({ ok: true, conversation_id: convRow.id });
});

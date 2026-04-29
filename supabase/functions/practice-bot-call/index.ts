import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxDial } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

const BodySchema = z.object({
  from_number_id: z.string().uuid(),
  target_number_id: z.string().uuid().optional(),
  target_number: z.string().min(8).optional(),
  chris_script: z.string().min(20).max(8000),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return jsonResponse({ error: "unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user?.id) return jsonResponse({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) return jsonResponse({ error: "forbidden" }, 403);

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);

  const { from_number_id, target_number_id, target_number, chris_script } = parsed.data;

  const { data: fromRow, error: fromErr } = await admin
    .from("phone_numbers")
    .select("id, e164_number, tenant_id, telnyx_connection_id, active")
    .eq("id", from_number_id)
    .maybeSingle();

  if (fromErr || !fromRow?.active) return jsonResponse({ error: "caller ID number not found or inactive" }, 400);
  if (!fromRow.telnyx_connection_id) return jsonResponse({ error: "caller ID number needs a Telnyx connection ID" }, 400);

  let targetNumber = target_number || "";
  let targetTenantId: string | null = null;
  if (target_number_id) {
    const { data: targetRow, error: targetErr } = await admin
      .from("phone_numbers")
      .select("e164_number, tenant_id, active")
      .eq("id", target_number_id)
      .maybeSingle();
    if (targetErr || !targetRow?.active) return jsonResponse({ error: "target inbound number not found or inactive" }, 400);
    targetNumber = targetRow.e164_number;
    targetTenantId = targetRow.tenant_id;
  } else if (targetNumber) {
    const { data: targetRow, error: targetErr } = await admin
      .from("phone_numbers")
      .select("e164_number, tenant_id, active")
      .eq("e164_number", targetNumber)
      .maybeSingle();
    if (targetErr || !targetRow?.active) {
      return jsonResponse({
        error: "manual target number must be active on the Phone numbers page so telnyx-inbound can route it to Sam",
      }, 400);
    }
    targetTenantId = targetRow.tenant_id;
  }
  if (!targetNumber.startsWith("+")) return jsonResponse({ error: "target number must be E.164, like +14155550100" }, 400);
  if (targetNumber === fromRow.e164_number) {
    return jsonResponse({ error: "caller ID and target inbound number must be different for a practice bot-to-bot call" }, 400);
  }

  const { data: tenantRow } = await admin
    .from("tenants")
    .select("name, timezone")
    .eq("id", targetTenantId || fromRow.tenant_id)
    .maybeSingle();

  const { data: convRow, error: convErr } = await admin
    .from("conversations")
    .insert({
      tenant_id: targetTenantId || fromRow.tenant_id,
      caller_phone: targetNumber,
      direction: "practice",
      agent_id: "practice_chris",
      telnyx_event_payload: {
        practice_bot: "chris",
        practice_target_number: targetNumber,
        practice_from_number: fromRow.e164_number,
        practice_script: chris_script,
      },
    })
    .select("id")
    .single();

  if (convErr || !convRow) {
    console.error("[practice-bot-call] conversation insert failed", convErr);
    return jsonResponse({ error: "failed to create practice conversation" }, 500);
  }

  const params = new URLSearchParams({
    conv: convRow.id,
    tenant: targetTenantId || fromRow.tenant_id,
    caller: fromRow.e164_number,
    name: "Chris",
    bot: "chris",
  });
  if (tenantRow?.name) params.set("company", tenantRow.name);
  if (tenantRow?.timezone) params.set("tz", tenantRow.timezone);

  const dialRes = await telnyxDial({
    to: targetNumber,
    from: fromRow.e164_number,
    connection_id: fromRow.telnyx_connection_id,
    stream_url: `${BRIDGE_WS_URL}?${params.toString()}`,
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
  });

  if (!dialRes.ok) {
    const txt = await dialRes.text();
    console.error(`[practice-bot-call] dial failed [${dialRes.status}]: ${txt}`);
    await admin
      .from("conversations")
      .update({ telnyx_call_status: "practice_dial_failed", telnyx_event_payload: { error: txt.slice(0, 500) } })
      .eq("id", convRow.id);
    return jsonResponse({ error: `dial failed: ${txt}` }, 502);
  }

  const dialData = await dialRes.json();
  const callPayload = dialData?.data ?? {};
  const callControlId = callPayload?.call_control_id ?? null;
  await admin
    .from("conversations")
    .update({
      telnyx_call_control_id: callControlId,
      telnyx_call_session_id: callPayload?.call_session_id ?? null,
      telnyx_call_leg_id: callPayload?.call_leg_id ?? null,
      telnyx_call_status: "practice_dial_request_accepted",
    })
    .eq("id", convRow.id);

  return jsonResponse({
    ok: true,
    conversation_id: convRow.id,
    call_control_id: callControlId,
    message: `Chris is dialing ${targetNumber} from ${fromRow.e164_number}.`,
  });
});

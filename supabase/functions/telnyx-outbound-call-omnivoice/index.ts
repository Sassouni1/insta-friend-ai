import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxDial } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// SANDBOX: streams to telnyx-bridge-omnivoice instead of telnyx-bridge so the live caller path is untouched.
const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge-omnivoice`;
const CHRIS_TEST_NUMBER = "+17276374672";

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  to_number: z.string().min(8),
  from_number: z.string().min(8).optional(),
  connection_id: z.string().min(1).optional(),
  caller_name: z.string().optional(),
  caller_email: z.string().email().optional(),
  test_call: z.boolean().optional(),
});

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

    // Parse body first so we can detect the sandbox-only Chris test bypass.
    const rawBody = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);
    }
    const { tenant_id, to_number, caller_name, caller_email } = parsed.data;
    const isChrisTestCall = parsed.data.test_call === true && to_number === CHRIS_TEST_NUMBER;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // SANDBOX-ONLY BYPASS: skip admin JWT check for Chris's test number.
    // Every other request keeps the full admin auth flow intact.
    if (!isChrisTestCall) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data: userData, error: userErr } = await userClient.auth.getUser(token);
      const userId = userData?.user?.id;
      if (userErr || !userId) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const { data: roleRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleRow) return jsonResponse({ error: "forbidden" }, 403);
    } else {
      console.log("[omnivoice-outbound] sandbox bypass: Chris test call to", to_number);
    }


    const { data: tenantRow } = await admin
      .from("tenants")
      .select("name, timezone, active")
      .eq("id", tenant_id)
      .maybeSingle();

    if (!tenantRow?.active && !isChrisTestCall) {
      return jsonResponse({ error: "tenant inactive; only Chris test calls are allowed while paused" }, 403);
    }

    let fromNumber = parsed.data.from_number || "";
    let connectionId = parsed.data.connection_id || "";
    if (!fromNumber || !connectionId) {
      const { data: phoneRow } = await admin
        .from("phone_numbers")
        .select("e164_number, telnyx_connection_id, active")
        .eq("tenant_id", tenant_id)
        .order("active", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!phoneRow?.e164_number || !phoneRow?.telnyx_connection_id) {
        return jsonResponse({ error: "no phone number configured for tenant" }, 400);
      }
      if (!phoneRow.active && !isChrisTestCall) {
        return jsonResponse({ error: "phone number inactive; only Chris test calls are allowed while paused" }, 403);
      }
      fromNumber = fromNumber || phoneRow.e164_number;
      connectionId = connectionId || phoneRow.telnyx_connection_id;
    }

    // Pre-create conversation row so we have an id for the stream URL
    const { data: convRow, error: convErr } = await admin
      .from("conversations")
      .insert({
        tenant_id,
        caller_phone: to_number,
        direction: "outbound",
      })
      .select("id")
      .single();

    if (convErr || !convRow) {
      return jsonResponse({ error: "failed to create conversation", details: convErr?.message }, 500);
    }

    const params = new URLSearchParams({
      conv: convRow.id,
      tenant: tenant_id,
      caller: to_number,
      direction: "outbound",
    });
    if (caller_name) params.set("name", caller_name);
    if (caller_email) params.set("email", caller_email);
    if (tenantRow?.name) params.set("company", tenantRow.name);
    if (tenantRow?.timezone) params.set("tz", tenantRow.timezone);

    const streamUrl = `${BRIDGE_WS_URL}?${params.toString()}`;

    const dialRes = await telnyxDial({
      to: to_number,
      from: fromNumber,
      connection_id: connectionId,
      stream_url: streamUrl,
      stream_track: "inbound_track",
      stream_codec: "PCMU",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "PCMU",
    });

    if (!dialRes.ok) {
      const txt = await dialRes.text();
      console.error(`[telnyx-outbound] dial failed [${dialRes.status}]: ${txt}`);
      return jsonResponse({ error: `dial failed: ${txt}` }, 502);
    }

    const dialData = await dialRes.json();
    const dialPayload = dialData?.data ?? {};
    const callControlId = dialPayload?.call_control_id ?? null;
    if (callControlId) {
      await admin
        .from("conversations")
        .update({
          telnyx_call_control_id: callControlId,
          telnyx_call_session_id: dialPayload?.call_session_id ?? null,
          telnyx_call_leg_id: dialPayload?.call_leg_id ?? null,
          telnyx_call_status: "dial_request_accepted",
          telnyx_event_payload: dialPayload,
        })
        .eq("id", convRow.id);
    }

    return jsonResponse({ ok: true, conversation_id: convRow.id, call_control_id: callControlId });
  } catch (err: any) {
    console.error("[telnyx-outbound] unhandled", err);
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});

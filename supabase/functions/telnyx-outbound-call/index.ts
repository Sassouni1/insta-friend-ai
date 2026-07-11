import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  ELEVENLABS_OUTBOUND_AGENT_ID,
  ELEVENLABS_SIP_FROM_NUMBER,
  ELEVENLABS_SIP_PHONE_NUMBER_ID,
  elevenLabsSipDial,
} from "../_shared/elevenlabs-sip.ts";
import { assertPhoneNotSuppressed } from "../_shared/opt-out.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    // Admin auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await userClient.auth.getUser(
      token,
    );
    const userId = userData?.user?.id;
    if (userErr || !userId) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return jsonResponse({ error: "forbidden" }, 403);

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);
    }
    const { tenant_id, to_number, caller_name, caller_email } = parsed.data;
    const isChrisTestCall = parsed.data.test_call === true &&
      to_number === CHRIS_TEST_NUMBER;

    await assertPhoneNotSuppressed(admin, tenant_id, to_number);

    const { data: tenantRow } = await admin
      .from("tenants")
      .select("name, timezone, active")
      .eq("id", tenant_id)
      .maybeSingle();

    if (!tenantRow?.active && !isChrisTestCall) {
      return jsonResponse({
        error:
          "tenant inactive; only Chris test calls are allowed while paused",
      }, 403);
    }

    const fromNumber = parsed.data.from_number || ELEVENLABS_SIP_FROM_NUMBER;
    if (fromNumber !== ELEVENLABS_SIP_FROM_NUMBER) {
      return jsonResponse({
        error:
          `caller ID ${fromNumber} is not connected to the direct ElevenLabs SIP trunk`,
      }, 400);
    }
    const { data: phoneRow } = await admin
      .from("phone_numbers")
      .select("e164_number, active")
      .eq("tenant_id", tenant_id)
      .eq("e164_number", fromNumber)
      .limit(1)
      .maybeSingle();
    if (!phoneRow?.e164_number) {
      return jsonResponse({
        error: "no ElevenLabs SIP caller ID configured for tenant",
      }, 400);
    }
    if (!phoneRow.active && !isChrisTestCall) {
      return jsonResponse({
        error:
          "phone number inactive; only Chris test calls are allowed while paused",
      }, 403);
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
      return jsonResponse({
        error: "failed to create conversation",
        details: convErr?.message,
      }, 500);
    }

    const dialData = await elevenLabsSipDial({
      toNumber: to_number,
      tenantId: tenant_id,
      conversationId: convRow.id,
      leadName: caller_name,
      leadEmail: caller_email,
      companyName: tenantRow?.name,
      tenantTimezone: tenantRow?.timezone,
    });

    await admin
      .from("conversations")
      .update({
        elevenlabs_agent_id: ELEVENLABS_OUTBOUND_AGENT_ID,
        elevenlabs_conversation_id: dialData.conversation_id,
        telnyx_call_status: "elevenlabs_sip_dial_accepted",
        telnyx_event_payload: {
          provider: "elevenlabs_sip",
          sip_phone_number_id: ELEVENLABS_SIP_PHONE_NUMBER_ID,
          sip_call_id: dialData.sip_call_id,
          from_number: fromNumber,
        },
      })
      .eq("id", convRow.id);

    return jsonResponse({
      ok: true,
      provider: "elevenlabs_sip",
      conversation_id: convRow.id,
      elevenlabs_conversation_id: dialData.conversation_id,
      sip_call_id: dialData.sip_call_id,
      call_control_id: null,
    });
  } catch (err: any) {
    console.error("[telnyx-outbound] unhandled", err);
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});

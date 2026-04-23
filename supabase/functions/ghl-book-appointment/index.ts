import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { GhlClient } from "../_shared/ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  caller_name: z.string().min(1),
  caller_phone: z.string().min(8),
  caller_email: z.string().email().optional(),
  slot_iso: z.string().datetime({ offset: true }),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const { tenant_id, conversation_id, caller_name, caller_phone, caller_email, slot_iso } = parsed.data;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("ghl_api_token, ghl_calendar_id, ghl_location_id")
    .eq("id", tenant_id)
    .maybeSingle();

  if (error || !tenant?.ghl_api_token || !tenant.ghl_calendar_id || !tenant.ghl_location_id) {
    return jsonResponse({ error: "tenant ghl config incomplete" }, 400);
  }

  try {
    const client = new GhlClient(tenant.ghl_api_token, tenant.ghl_location_id);
    const [firstName, ...rest] = caller_name.trim().split(/\s+/);
    const lastName = rest.join(" ") || undefined;

    const contact = await client.upsertContact({
      firstName,
      lastName,
      email: caller_email,
      phone: caller_phone,
    });

    const appt = await client.createAppointment({
      calendarId: tenant.ghl_calendar_id,
      contactId: contact.id,
      startTime: slot_iso,
    });

    await supabase.from("bookings").insert({
      tenant_id,
      conversation_id: conversation_id || null,
      caller_name,
      caller_phone,
      caller_email: caller_email || null,
      slot_iso,
      ghl_appointment_id: appt.id,
      status: "confirmed",
    });

    return jsonResponse({
      ok: true,
      appointment_id: appt.id,
      contact_id: contact.id,
      confirmation: `Booked ${caller_name} for ${slot_iso}`,
    });
  } catch (err: any) {
    console.error("[ghl-book-appointment]", err);
    return jsonResponse({ error: err.message || "failed" }, 500);
  }
});

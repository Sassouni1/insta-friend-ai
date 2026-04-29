import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { GhlClient, flattenSlots, getFreshGhlToken } from "../_shared/ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TENANT_ID = "8ad5b297-2581-4953-91bb-7cef9a8f2080";

const AvailabilitySchema = z.object({
  action: z.literal("availability"),
  tenant_id: z.string().uuid().optional(),
  days_ahead: z.number().int().min(1).max(30).default(7),
});

const BookSchema = z.object({
  action: z.literal("book"),
  tenant_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  caller_name: z.string().min(1).default("Chris"),
  caller_phone: z.string().min(8),
  caller_email: z.string().email().optional(),
  slot_iso: z.string().datetime({ offset: true }),
});

const BodySchema = z.discriminatedUnion("action", [AvailabilitySchema, BookSchema]);

function formatSlotForSpeech(slotIso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(slotIso));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tenantId = parsed.data.tenant_id || TENANT_ID;
  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("ghl_calendar_id, timezone")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !tenant?.ghl_calendar_id) {
    return jsonResponse({ error: "tenant ghl config incomplete" }, 400);
  }

  try {
    const { token, locationId } = await getFreshGhlToken(supabase, tenantId);
    const client = new GhlClient(token, locationId);

    if (parsed.data.action === "availability") {
      const startMs = Date.now();
      const endMs = startMs + parsed.data.days_ahead * 24 * 60 * 60 * 1000;
      const raw = await client.getCalendarSlots(tenant.ghl_calendar_id, startMs, endMs, tenant.timezone);
      const all = flattenSlots(raw);
      const options = all.slice(0, 4).map((slotIso, index) => ({
        option: index + 1,
        slot_iso: slotIso,
        spoken: formatSlotForSpeech(slotIso, tenant.timezone),
      }));

      return jsonResponse({
        ok: true,
        timezone: tenant.timezone,
        total_available: all.length,
        options,
        instruction: "Offer two options to the caller. If they choose one, call this tool again with action=book and the exact slot_iso.",
      });
    }

    const [firstName, ...rest] = parsed.data.caller_name.trim().split(/\s+/);
    const contact = await client.upsertContact({
      firstName,
      lastName: rest.join(" ") || undefined,
      email: parsed.data.caller_email,
      phone: parsed.data.caller_phone,
    });
    const appt = await client.createAppointment({
      calendarId: tenant.ghl_calendar_id,
      contactId: contact.id,
      startTime: parsed.data.slot_iso,
    });

    await supabase.from("bookings").insert({
      tenant_id: tenantId,
      conversation_id: parsed.data.conversation_id || null,
      caller_name: parsed.data.caller_name,
      caller_phone: parsed.data.caller_phone,
      caller_email: parsed.data.caller_email || null,
      slot_iso: parsed.data.slot_iso,
      ghl_appointment_id: appt.id,
      status: "confirmed",
    });

    return jsonResponse({
      ok: true,
      appointment_id: appt.id,
      contact_id: contact.id,
      confirmation: `Booked ${parsed.data.caller_name} for ${formatSlotForSpeech(parsed.data.slot_iso, tenant.timezone)}.`,
    });
  } catch (err: any) {
    console.error("[ghl-calendar-tool]", err);
    return jsonResponse({ ok: false, error: err.message || "failed" }, 500);
  }
});

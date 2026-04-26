// GoHighLevel v2 API client (per-tenant token).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";
const TOKEN_URL = `${GHL_BASE}/oauth/token`;

export interface GhlSlot {
  startTime: string;
  endTime: string;
}

export class GhlClient {
  constructor(
    private token: string,
    private locationId: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const url = `${GHL_BASE}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Version: GHL_VERSION,
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      throw new Error(`GHL ${path} failed [${res.status}]: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }
    return data;
  }

  async getCalendarSlots(calendarId: string, startMs: number, endMs: number, timezone: string): Promise<Record<string, { slots: string[] }>> {
    const params = new URLSearchParams({
      startDate: String(startMs),
      endDate: String(endMs),
      timezone,
    });
    return this.request(`/calendars/${calendarId}/free-slots?${params.toString()}`);
  }

  async upsertContact(input: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  }): Promise<{ id: string }> {
    const data = await this.request(`/contacts/upsert`, {
      method: "POST",
      body: JSON.stringify({ ...input, locationId: this.locationId }),
    });
    return { id: data?.contact?.id || data?.id };
  }

  async getContact(contactId: string): Promise<any> {
    const data = await this.request(`/contacts/${contactId}`);
    return data?.contact || data;
  }

  async getContactAppointments(contactId: string): Promise<any[]> {
    const data = await this.request(`/contacts/${contactId}/appointments`);
    return data?.events || data?.appointments || [];
  }

  async createAppointment(input: {
    calendarId: string;
    contactId: string;
    startTime: string;
    endTime?: string;
    title?: string;
  }): Promise<{ id: string }> {
    const data = await this.request(`/calendars/events/appointments`, {
      method: "POST",
      body: JSON.stringify({
        ...input,
        locationId: this.locationId,
        appointmentStatus: "confirmed",
      }),
    });
    return { id: data?.id || data?.appointment?.id };
  }
}

export function flattenSlots(slotMap: Record<string, { slots: string[] }>): string[] {
  const all: string[] = [];
  for (const day of Object.values(slotMap)) {
    if (day && Array.isArray(day.slots)) all.push(...day.slots);
  }
  return all.sort();
}

/**
 * Get a fresh access token for a tenant, refreshing via OAuth if needed.
 * Persists the new token + expiry back to the tenants row.
 */
export async function getFreshGhlToken(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<{ token: string; locationId: string }> {
  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("ghl_api_token, ghl_refresh_token, ghl_token_expires_at, ghl_location_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !tenant) throw new Error(`tenant ${tenantId} not found`);
  if (!tenant.ghl_location_id) throw new Error(`tenant ${tenantId} has no ghl_location_id`);
  if (!tenant.ghl_api_token) throw new Error(`tenant ${tenantId} has no GHL token (reconnect required)`);

  const expiresAt = tenant.ghl_token_expires_at ? new Date(tenant.ghl_token_expires_at).getTime() : 0;
  const fiveMinFromNow = Date.now() + 5 * 60 * 1000;

  // Token still valid for >5 min: use as-is
  if (expiresAt > fiveMinFromNow) {
    return { token: tenant.ghl_api_token, locationId: tenant.ghl_location_id };
  }

  // Need to refresh
  if (!tenant.ghl_refresh_token) {
    throw new Error(`tenant ${tenantId} token expired and no refresh_token (reconnect required)`);
  }

  const clientId = Deno.env.get("GHL_CLIENT_ID");
  const clientSecret = Deno.env.get("GHL_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("GHL_CLIENT_ID/SECRET not configured");

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: tenant.ghl_refresh_token,
    user_type: "Location",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`GHL token refresh failed [${res.status}]: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const newToken: string = json.access_token;
  const newRefresh: string = json.refresh_token || tenant.ghl_refresh_token;
  const newExpires = new Date(Date.now() + Number(json.expires_in || 86400) * 1000).toISOString();

  await supabase
    .from("tenants")
    .update({
      ghl_api_token: newToken,
      ghl_refresh_token: newRefresh,
      ghl_token_expires_at: newExpires,
    })
    .eq("id", tenantId);

  return { token: newToken, locationId: tenant.ghl_location_id };
}

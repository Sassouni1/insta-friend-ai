// GoHighLevel v2 API client (per-tenant token).

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";

export interface GhlSlot {
  startTime: string; // ISO
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

  async createAppointment(input: {
    calendarId: string;
    contactId: string;
    startTime: string; // ISO
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

// Flatten slot map into a sorted array of ISO start times.
export function flattenSlots(slotMap: Record<string, { slots: string[] }>): string[] {
  const all: string[] = [];
  for (const day of Object.values(slotMap)) {
    if (day && Array.isArray(day.slots)) all.push(...day.slots);
  }
  return all.sort();
}

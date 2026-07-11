import { buildElevenLabsSipCallPayload } from "./elevenlabs-sip-payload.ts";

export const ELEVENLABS_OUTBOUND_AGENT_ID =
  Deno.env.get("ELEVENLABS_OUTBOUND_AGENT_ID")?.trim() ||
  "agent_9201kr7jkn3xfz2sr11sngjnqxwh";

export const ELEVENLABS_SIP_PHONE_NUMBER_ID =
  Deno.env.get("ELEVENLABS_SIP_PHONE_NUMBER_ID")?.trim() ||
  "phnum_9501kx7mf009fgavdh20kfmpt6cz";

export const ELEVENLABS_SIP_FROM_NUMBER =
  Deno.env.get("ELEVENLABS_SIP_FROM_NUMBER")?.trim() ||
  "+17276260945";

type SipDialOptions = {
  toNumber: string;
  tenantId: string;
  conversationId: string;
  leadName?: string | null;
  leadEmail?: string | null;
  companyName?: string | null;
  tenantTimezone?: string | null;
};

export type ElevenLabsSipDialResult = {
  success: boolean;
  message: string;
  conversation_id: string | null;
  sip_call_id: string | null;
};

export async function elevenLabsSipDial(
  options: SipDialOptions,
): Promise<ElevenLabsSipDialResult> {
  const apiKey = Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim() ||
    Deno.env.get("ELEVENLABS_API_KEY")?.trim();
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY_CUSTOM not configured");

  const payload = buildElevenLabsSipCallPayload({
    agentId: ELEVENLABS_OUTBOUND_AGENT_ID,
    phoneNumberId: ELEVENLABS_SIP_PHONE_NUMBER_ID,
    toNumber: options.toNumber,
    tenantId: options.tenantId,
    conversationId: options.conversationId,
    leadName: options.leadName,
    leadEmail: options.leadEmail,
    companyName: options.companyName,
    tenantTimezone: options.tenantTimezone,
  });

  const response = await fetch(
    "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    },
  );

  const bodyText = await response.text();
  let data: any = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const detail = data?.detail || data?.message || bodyText ||
      "unknown ElevenLabs error";
    throw new Error(
      `ElevenLabs SIP dial ${response.status}: ${String(detail).slice(0, 400)}`,
    );
  }
  if (data?.success !== true || !data?.conversation_id) {
    throw new Error(
      `ElevenLabs SIP dial was not accepted: ${
        String(data?.message || "missing conversation id").slice(0, 400)
      }`,
    );
  }

  return data as ElevenLabsSipDialResult;
}

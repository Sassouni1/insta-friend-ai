// Telnyx Call Control helpers + Ed25519 webhook signature verification.

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

export async function telnyxCallControl(
  callControlId: string,
  command: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  const apiKey = Deno.env.get("TELNYX_API_KEY");
  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");

  const url = `${TELNYX_API_BASE}/calls/${callControlId}/actions/${command}`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function telnyxDial(params: {
  to: string;
  from: string;
  connection_id: string;
  stream_url?: string;
  stream_track?: "inbound_track" | "outbound_track" | "both_tracks";
  // NOTE: stream_bidirectional_mode/codec intentionally omitted.
  // Our bridge speaks the WebSocket JSON media protocol, not RTP-over-UDP.
  // Setting bidirectional_mode causes Telnyx to fail stream negotiation.
  stream_codec?: "PCMU" | "PCMA" | "G722" | "OPUS";
  client_state?: string;
  timeout_secs?: number;
}): Promise<Response> {
  const apiKey = Deno.env.get("TELNYX_API_KEY");
  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");

  return fetch(`${TELNYX_API_BASE}/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
}

// Verify Telnyx Ed25519 webhook signature.
// Spec: signature = base64(Ed25519(timestamp + "|" + raw_body)), public key is Ed25519 raw 32 bytes (base64).
export async function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string | null,
  timestamp: string | null,
  publicKeyB64: string,
): Promise<boolean> {
  if (!signatureB64 || !timestamp) return false;
  try {
    const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    const signature = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    const publicKeyRaw = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
      "raw",
      publicKeyRaw,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch (err) {
    console.error("[telnyx] signature verify error:", err);
    return false;
  }
}

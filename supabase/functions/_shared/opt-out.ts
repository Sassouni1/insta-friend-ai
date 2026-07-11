export function normalizePhoneForSuppression(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : "";
}

export async function isPhoneSuppressed(
  supabase: any,
  tenantId: string,
  phone: string,
): Promise<boolean> {
  const normalized = normalizePhoneForSuppression(phone);
  if (!normalized) return false;
  const { data, error } = await supabase
    .from("call_opt_outs")
    .select("phone_normalized")
    .eq("tenant_id", tenantId)
    .eq("phone_normalized", normalized)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`opt-out lookup failed: ${error.message}`);
  return Boolean(data);
}

export async function assertPhoneNotSuppressed(
  supabase: any,
  tenantId: string,
  phone: string,
): Promise<void> {
  if (await isPhoneSuppressed(supabase, tenantId, phone)) {
    throw new Error("call blocked: phone number has opted out");
  }
}

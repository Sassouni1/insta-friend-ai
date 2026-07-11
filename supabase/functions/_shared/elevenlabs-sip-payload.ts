export type ElevenLabsSipCallInput = {
  agentId: string;
  phoneNumberId: string;
  toNumber: string;
  tenantId: string;
  conversationId: string;
  leadName?: string | null;
  leadEmail?: string | null;
  companyName?: string | null;
  tenantTimezone?: string | null;
  doubleDialAttempt?: number;
};

function firstNameFrom(fullName?: string | null): string {
  return (fullName || "").trim().split(/\s+/)[0] || "";
}

export function buildElevenLabsSipCallPayload(input: ElevenLabsSipCallInput) {
  const callerName = (input.leadName || "").trim();
  const firstName = firstNameFrom(callerName);
  const companyName = (input.companyName || "Infinite Hair").trim();
  const tenantTimezone = (input.tenantTimezone || "America/New_York").trim();

  const conversationConfigOverride = firstName ? undefined : {
    agent: {
      first_message:
        `Hey—this is Sam with ${companyName}. You recently asked about hair systems. Did I catch you at an okay time?`,
    },
  };

  return {
    agent_id: input.agentId,
    agent_phone_number_id: input.phoneNumberId,
    to_number: input.toNumber,
    conversation_initiation_client_data: {
      user_id: input.toNumber,
      ...(conversationConfigOverride
        ? { conversation_config_override: conversationConfigOverride }
        : {}),
      dynamic_variables: {
        tenant_id: input.tenantId,
        conversation_id: input.conversationId,
        caller_phone: input.toNumber,
        caller_name: callerName,
        caller_email: (input.leadEmail || "").trim(),
        first_name: firstName,
        company_name: companyName,
        tenant_timezone: tenantTimezone,
        call_direction: "outbound",
        double_dial_attempt: input.doubleDialAttempt || 1,
        booking_verified: false,
        booked_appointment_id: "",
        booking_confirmation: "",
      },
    },
    telephony_call_config: {
      ringing_timeout_secs: 45,
    },
  };
}

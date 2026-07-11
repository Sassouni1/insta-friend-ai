import { describe, expect, it } from "vitest";
import { buildElevenLabsSipCallPayload } from "../../supabase/functions/_shared/elevenlabs-sip-payload";

describe("direct ElevenLabs SIP payload", () => {
  it("passes every booking and personalization variable to the stable agent", () => {
    const payload = buildElevenLabsSipCallPayload({
      agentId: "agent_stable",
      phoneNumberId: "phnum_direct",
      toNumber: "+17276374672",
      tenantId: "721ca656-4c25-4ced-bd2e-4f03e8b3bacc",
      conversationId: "5038d092-1ebc-4009-8e89-19e22a5a7bac",
      leadName: "Chris Sassouni",
      leadEmail: "chris@invasiondigitalmedia.com",
      companyName: "Infinite Hair",
      tenantTimezone: "America/New_York",
    });

    expect(payload.agent_id).toBe("agent_stable");
    expect(payload.agent_phone_number_id).toBe("phnum_direct");
    expect(payload.to_number).toBe("+17276374672");
    expect(payload.conversation_initiation_client_data.dynamic_variables)
      .toMatchObject({
        tenant_id: "721ca656-4c25-4ced-bd2e-4f03e8b3bacc",
        conversation_id: "5038d092-1ebc-4009-8e89-19e22a5a7bac",
        caller_phone: "+17276374672",
        caller_name: "Chris Sassouni",
        caller_email: "chris@invasiondigitalmedia.com",
        first_name: "Chris",
        company_name: "Infinite Hair",
        tenant_timezone: "America/New_York",
        double_dial_attempt: 1,
      });
  });

  it("uses a natural generic opener when a lead name is unavailable", () => {
    const payload = buildElevenLabsSipCallPayload({
      agentId: "agent_stable",
      phoneNumberId: "phnum_direct",
      toNumber: "+14155550100",
      tenantId: "tenant",
      conversationId: "conversation",
      companyName: "Infinite Hair",
    });

    expect(
      payload.conversation_initiation_client_data.conversation_config_override
        ?.agent.first_message,
    )
      .toContain("this is Sam with Infinite Hair");
    expect(
      payload.conversation_initiation_client_data.dynamic_variables.first_name,
    ).toBe("");
  });

  it("marks a retry as the second and final double-dial attempt", () => {
    const payload = buildElevenLabsSipCallPayload({
      agentId: "agent_stable",
      phoneNumberId: "phnum_direct",
      toNumber: "+14155550100",
      tenantId: "tenant",
      conversationId: "retry-conversation",
      doubleDialAttempt: 2,
    });

    expect(
      payload.conversation_initiation_client_data.dynamic_variables
        .double_dial_attempt,
    ).toBe(2);
  });
});

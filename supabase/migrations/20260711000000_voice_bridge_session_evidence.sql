alter table public.conversations
  add column if not exists elevenlabs_agent_id text,
  add column if not exists agent_config_version text,
  add column if not exists elevenlabs_conversation_id text,
  add column if not exists bridge_session_count integer not null default 0,
  add column if not exists bridge_reconnect_count integer not null default 0,
  add column if not exists agent_output_alert_count integer not null default 0;

create or replace function public.register_voice_bridge_session(
  p_conversation_id uuid,
  p_agent_id text,
  p_config_version text
)
returns table (session_count integer, reconnect_count integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.conversations
  set
    elevenlabs_agent_id = p_agent_id,
    agent_config_version = p_config_version,
    bridge_reconnect_count = bridge_reconnect_count + case when bridge_session_count > 0 then 1 else 0 end,
    bridge_session_count = bridge_session_count + 1
  where id = p_conversation_id
  returning bridge_session_count, bridge_reconnect_count;
end;
$$;

revoke all on function public.register_voice_bridge_session(uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_voice_bridge_session(uuid, text, text) to service_role;

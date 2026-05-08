alter table public.conversations
  add column if not exists bridge_calendar_tool_call_count integer not null default 0,
  add column if not exists bridge_calendar_tool_error_count integer not null default 0,
  add column if not exists bridge_last_calendar_tool_name text,
  add column if not exists bridge_last_calendar_tool_params jsonb,
  add column if not exists bridge_last_calendar_tool_result jsonb,
  add column if not exists bridge_last_calendar_tool_error text,
  add column if not exists bridge_last_calendar_tool_at timestamptz;
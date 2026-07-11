alter table public.conversations
  add column if not exists double_dial_attempt integer not null default 1,
  add column if not exists double_dial_parent_conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists double_dial_retry_started_at timestamptz,
  add column if not exists double_dial_retry_conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists double_dial_retry_error text;

alter table public.conversations
  drop constraint if exists conversations_double_dial_attempt_check;

alter table public.conversations
  add constraint conversations_double_dial_attempt_check
  check (double_dial_attempt in (1, 2));

create unique index if not exists conversations_one_double_dial_retry_idx
  on public.conversations (double_dial_parent_conversation_id)
  where double_dial_parent_conversation_id is not null;

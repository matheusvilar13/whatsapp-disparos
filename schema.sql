create extension if not exists "uuid-ossp";

create table if not exists contacts (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  phone_e164 text not null unique,
  opt_in boolean not null default true,
  opt_in_at timestamptz not null default now(),
  coupon_status text not null default 'pending',
  first_inbound_at timestamptz,
  last_inbound_at timestamptz,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  template_name text not null,
  template_lang text not null default 'pt_BR',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  contact_id uuid references contacts(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  template_name text,
  template_lang text,
  params jsonb,
  wa_message_id text,
  status text not null default 'queued',
  error text,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_contacts_optin on contacts(opt_in);
create index if not exists idx_messages_contact on messages(contact_id);
create index if not exists idx_messages_status on messages(status);

create table if not exists app_settings (
  id integer primary key default 1,
  event_name text,
  coupon_code text,
  photos_link text,
  updated_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default uuid_generate_v4(),
  contact_id uuid references contacts(id) on delete cascade,
  direction text not null, -- 'in' | 'out'
  body text,
  wa_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_contact on chat_messages(contact_id);
create index if not exists idx_chat_messages_created_at on chat_messages(created_at);

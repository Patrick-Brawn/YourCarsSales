
-- ============================================================
-- YOUR SALES CARS
-- Migration 0001: Fundação do sistema
-- Perfis, papéis, economia, níveis e auditoria
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. PAPÉIS
-- ============================================================

create type public.app_role as enum (
  'player',
  'moderator',
  'admin'
);

-- ============================================================
-- 2. PERFIS
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique
    check (username ~ '^[a-zA-Z0-9_]{3,24}$'),
  display_name text,
  avatar_url text,
  role public.app_role not null default 'player',
  created_at timestamptz not null default now()
);

-- Verifica se o usuário atual é administrador
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

-- Consulta segura do papel do usuário atual
create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid();
$$;

-- ============================================================
-- 3. CRIAÇÃO AUTOMÁTICA DE PERFIL
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    username,
    display_name
  )
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'username', ''),
      'user_' || substr(new.id::text, 1, 8)
    ),
    new.raw_user_meta_data->>'display_name'
  );

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

-- ============================================================
-- 4. CONFIGURAÇÕES DA ECONOMIA
-- ============================================================

create table public.game_settings (
  key text primary key,
  value jsonb not null,
  description text,
  is_verified boolean not null default false,
  source_note text,
  updated_at timestamptz not null default now()
);

insert into public.game_settings (
  key,
  value,
  description,
  source_note
)
values
(
  'starting_cash_cents',
  '2000000'::jsonb,
  'Capital inicial do jogador (R$ 20.000,00)',
  'ESTIMATIVA PRÓPRIA — não verificada'
),
(
  'market_tick_minutes',
  '20'::jsonb,
  'Intervalo de oscilação do mercado',
  'Definido no briefing'
),
(
  'market_max_deviation_pct',
  '15'::jsonb,
  'Limite absoluto ± sobre o preço original de referência',
  'Definido no briefing (obrigatório)'
),
(
  'market_tick_fraction',
  '0.25'::jsonb,
  'Fração dos veículos que oscilam a cada tick',
  'ESTIMATIVA PRÓPRIA — não verificada'
),
(
  'sellers_unlock_store_level',
  '5'::jsonb,
  'Nível da loja que libera contratação',
  'Definido no briefing'
),
(
  'candidates_per_page',
  '6'::jsonb,
  'Candidatos a vendedor por página',
  'Definido no briefing'
);

-- ============================================================
-- 5. NÍVEIS DE JOGADOR E LOJA
-- ============================================================

create type public.level_kind as enum (
  'player',
  'store'
);

create table public.game_levels (
  kind public.level_kind not null,
  level int not null check (level >= 1),
  title text not null,
  sales_required int not null default 0
    check (sales_required >= 0),
  net_worth_required_cents bigint not null default 0
    check (net_worth_required_cents >= 0),
  profit_required_cents bigint not null default 0
    check (profit_required_cents >= 0),
  expansion_cost_cents bigint not null default 0
    check (expansion_cost_cents >= 0),
  garage_slots int,
  seller_slots int,
  rewards jsonb not null default '{}'::jsonb,
  unlocks jsonb not null default '[]'::jsonb,
  is_verified boolean not null default false,
  source_note text not null default
    'ESTIMATIVA PRÓPRIA — não verificada contra o site de referência',
  primary key (kind, level)
);

-- Criação de 20 níveis iniciais para cada categoria
insert into public.game_levels (
  kind,
  level,
  title,
  sales_required,
  net_worth_required_cents,
  profit_required_cents,
  expansion_cost_cents,
  garage_slots,
  seller_slots,
  unlocks
)
select
  k.kind,
  n,
  (case k.kind
    when 'player' then 'Vendedor '
    else 'Loja '
  end) || 'Nível ' || n,

  floor(2 * power(n - 1, 1.8))::int,

  case
    when n = 1 then 0
    else floor(5000000 * power(1.55, n - 1))::bigint
  end,

  case
    when n = 1 then 0
    else floor(2000000 * power(1.55, n - 1))::bigint
  end,

  case
    when n = 1 or k.kind = 'player' then 0
    else floor(1500000 * power(1.6, n - 2))::bigint
  end,

  case
    when k.kind = 'store' then 5 * n
  end,

  case
    when k.kind = 'store' then greatest(0, n - 4)
  end,

  case
    when k.kind = 'store' and n = 5
    then '["time_de_vendas"]'::jsonb
    else '[]'::jsonb
  end

from (
  values
    ('player'::public.level_kind),
    ('store'::public.level_kind)
) as k(kind)

cross join generate_series(1, 20) as n;

-- ============================================================
-- 6. AUDITORIA
-- ============================================================

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity text not null,
  entity_key text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

-- Registra alterações nas configurações e níveis
create or replace function public.log_config_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (
    actor_id,
    action,
    entity,
    entity_key,
    before,
    after
  )
  values (
    auth.uid(),
    tg_op,
    tg_table_name,
    coalesce(
      to_jsonb(new)->>'key',
      (to_jsonb(new)->>'kind') || ':' ||
      (to_jsonb(new)->>'level')
    ),
    case
      when tg_op = 'INSERT' then null
      else to_jsonb(old)
    end,
    to_jsonb(new)
  );

  return new;
end;
$$;

create trigger audit_game_settings
after insert or update on public.game_settings
for each row
execute function public.log_config_change();

create trigger audit_game_levels
after insert or update on public.game_levels
for each row
execute function public.log_config_change();

-- ============================================================
-- 7. ROW LEVEL SECURITY (RLS)
-- ============================================================

alter table public.profiles enable row level security;
alter table public.game_settings enable row level security;
alter table public.game_levels enable row level security;
alter table public.audit_log enable row level security;

-- ----------------------------
-- PERFIS
-- ----------------------------

create policy profiles_read
on public.profiles
for select
using (true);

create policy profiles_update_own
on public.profiles
for update
using (id = auth.uid())
with check (
  id = auth.uid()
  and role = public.current_app_role()
);

create policy profiles_admin_all
on public.profiles
for all
using (public.is_admin())
with check (public.is_admin());

-- ----------------------------
-- CONFIGURAÇÕES
-- ----------------------------

create policy settings_read
on public.game_settings
for select
using (true);

create policy settings_admin_write
on public.game_settings
for all
using (public.is_admin())
with check (public.is_admin());

-- ----------------------------
-- NÍVEIS
-- ----------------------------

create policy levels_read
on public.game_levels
for select
using (true);

create policy levels_admin_write
on public.game_levels
for all
using (public.is_admin())
with check (public.is_admin());

-- ----------------------------
-- AUDITORIA
-- ----------------------------

create policy audit_admin_read
on public.audit_log
for select
using (public.is_admin());

-- ============================================================
-- FIM DA MIGRATION 0001
-- YOUR SALES CARS
-- ============================================================

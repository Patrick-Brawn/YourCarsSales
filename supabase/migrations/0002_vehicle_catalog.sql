
-- ============================================================
-- YOUR SALES CARS
-- MIGRATION 0002
-- CATALOGO FIPE + FOTOGRAFIAS + MERCADO AUTOMOTIVO
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. REFERENCIAS FIPE
-- ============================================================

create table public.fipe_references (
  id uuid primary key default gen_random_uuid(),

  reference_code text not null unique,
  reference_month date not null unique,

  is_current boolean not null default false,

  created_at timestamptz not null default now(),

  check (extract(day from reference_month) = 1)
);

create unique index one_current_fipe_reference
on public.fipe_references (is_current)
where is_current = true;

-- ============================================================
-- 2. FABRICANTES
-- ============================================================

create table public.vehicle_brands (
  id uuid primary key default gen_random_uuid(),

  fipe_brand_code text not null unique,
  name text not null,

  country text,
  logo_url text,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 3. MODELOS
-- ============================================================

create table public.vehicle_models (
  id uuid primary key default gen_random_uuid(),

  brand_id uuid not null
    references public.vehicle_brands(id)
    on delete restrict,

  fipe_model_code text not null,

  name text not null,

  vehicle_type text not null default 'car'
    check (
      vehicle_type in ('car', 'motorcycle', 'truck')
    ),

  category text,

  description text,

  image_url text,
  image_source text,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (brand_id, fipe_model_code, vehicle_type)
);

create index vehicle_models_brand_idx
on public.vehicle_models(brand_id);

-- ============================================================
-- 4. CATALOGO INDIVIDUAL DE VEICULOS
-- Cada ano, versao e combustivel possui seu proprio codigo FIPE.
-- ============================================================

create table public.vehicle_catalog (
  id uuid primary key default gen_random_uuid(),

  model_id uuid not null
    references public.vehicle_models(id)
    on delete restrict,

  fipe_code text not null unique,

  version_name text not null,

  model_year int not null
    check (model_year between 1900 and 2100),

  manufacture_year int,

  fuel_type text not null,

  transmission text,
  engine text,

  current_reference_month date
    references public.fipe_references(reference_month),

  current_reference_price_cents bigint
    check (
      current_reference_price_cents is null
      or current_reference_price_cents > 0
    ),

  -- FOTO PRINCIPAL REAL
  image_url text,

  -- ORIGEM DA FOTO
  image_source text,

  -- IDENTIFICACAO E VERIFICACAO DA IMAGEM
  image_verified boolean not null default false,

  image_verified_at timestamptz,

  -- GALERIA DE FOTOS ADICIONAIS
  image_gallery jsonb not null default '[]'::jsonb,

  -- INFORMACOES ADICIONAIS
  extra_data jsonb not null default '{}'::jsonb,

  is_active boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_gallery_array
    check (jsonb_typeof(image_gallery) = 'array'),

  constraint catalog_image_verification
    check (
      not image_verified
      or (
        image_url is not null
        and image_source is not null
        and image_verified_at is not null
      )
    ),

  constraint catalog_publication_image
    check (
      not is_active
      or (
        image_verified = true
        and image_url is not null
      )
    )
);

create index vehicle_catalog_model_idx
on public.vehicle_catalog(model_id);

create index vehicle_catalog_year_idx
on public.vehicle_catalog(model_year);

create index vehicle_catalog_fuel_idx
on public.vehicle_catalog(fuel_type);

create index vehicle_catalog_active_idx
on public.vehicle_catalog(is_active);

create index vehicle_catalog_fipe_idx
on public.vehicle_catalog(fipe_code);

-- ============================================================
-- 5. HISTORICO MENSAL DOS PRECOS FIPE
-- ============================================================

create table public.vehicle_fipe_prices (
  id uuid primary key default gen_random_uuid(),

  vehicle_id uuid not null
    references public.vehicle_catalog(id)
    on delete restrict,

  reference_month date not null
    references public.fipe_references(reference_month),

  price_cents bigint not null
    check (price_cents > 0),

  currency text not null default 'BRL',

  source text not null default 'FIPE_API',

  fetched_at timestamptz not null default now(),

  source_payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  unique (vehicle_id, reference_month)
);

create index vehicle_fipe_prices_vehicle_idx
on public.vehicle_fipe_prices(vehicle_id);

create index vehicle_fipe_prices_month_idx
on public.vehicle_fipe_prices(reference_month);

-- ============================================================
-- 6. PRECOS DINAMICOS DO MERCADO
-- Oscilacao maxima de 15% sobre a referencia FIPE.
-- ============================================================

create table public.vehicle_market_prices (
  id uuid primary key default gen_random_uuid(),

  vehicle_id uuid not null unique
    references public.vehicle_catalog(id)
    on delete restrict,

  reference_price_cents bigint not null
    check (reference_price_cents > 0),

  market_price_cents bigint not null
    check (market_price_cents > 0),

  variation_pct numeric(6,3) not null default 0,

  last_market_tick timestamptz,

  updated_at timestamptz not null default now(),

  constraint market_price_limit check (
    market_price_cents >=
      ceil(reference_price_cents * 0.85)::bigint
    and
    market_price_cents <=
      floor(reference_price_cents * 1.15)::bigint
  ),

  constraint market_variation_limit check (
    variation_pct between -15 and 15
  )
);

create index vehicle_market_prices_price_idx
on public.vehicle_market_prices(market_price_cents);

-- ============================================================
-- 7. HISTORICO DE SINCRONIZACOES FIPE
-- ============================================================

create table public.fipe_sync_runs (
  id uuid primary key default gen_random_uuid(),

  reference_month date,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'running',
        'success',
        'partial',
        'failed'
      )
    ),

  brands_processed int not null default 0,
  models_processed int not null default 0,
  vehicles_processed int not null default 0,
  prices_updated int not null default 0,

  started_at timestamptz,
  finished_at timestamptz,

  error_message text,

  source text not null default 'FIPE_API',

  details jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index fipe_sync_runs_created_idx
on public.fipe_sync_runs(created_at desc);

-- ============================================================
-- 8. ATUALIZACAO AUTOMATICA DE updated_at
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger vehicle_brands_updated_at
before update on public.vehicle_brands
for each row
execute function public.set_updated_at();

create trigger vehicle_models_updated_at
before update on public.vehicle_models
for each row
execute function public.set_updated_at();

create trigger vehicle_catalog_updated_at
before update on public.vehicle_catalog
for each row
execute function public.set_updated_at();

create trigger vehicle_market_prices_updated_at
before update on public.vehicle_market_prices
for each row
execute function public.set_updated_at();

-- ============================================================
-- 9. ROW LEVEL SECURITY
-- ============================================================

alter table public.fipe_references enable row level security;
alter table public.vehicle_brands enable row level security;
alter table public.vehicle_models enable row level security;
alter table public.vehicle_catalog enable row level security;
alter table public.vehicle_fipe_prices enable row level security;
alter table public.vehicle_market_prices enable row level security;
alter table public.fipe_sync_runs enable row level security;

-- ============================================================
-- 10. LEITURA PUBLICA
-- ============================================================

create policy fipe_references_read
on public.fipe_references
for select
using (true);

create policy vehicle_brands_read
on public.vehicle_brands
for select
using (true);

create policy vehicle_models_read
on public.vehicle_models
for select
using (true);

-- Somente veiculos com fotografia real verificada
-- e publicados ficam disponiveis para os jogadores.

create policy vehicle_catalog_read
on public.vehicle_catalog
for select
using (
  is_active = true
  and image_verified = true
  and image_url is not null
);

create policy vehicle_fipe_prices_read
on public.vehicle_fipe_prices
for select
using (
  exists (
    select 1
    from public.vehicle_catalog vc
    where vc.id = vehicle_fipe_prices.vehicle_id
      and vc.is_active = true
      and vc.image_verified = true
  )
);

create policy vehicle_market_prices_read
on public.vehicle_market_prices
for select
using (
  exists (
    select 1
    from public.vehicle_catalog vc
    where vc.id = vehicle_market_prices.vehicle_id
      and vc.is_active = true
      and vc.image_verified = true
  )
);

-- ============================================================
-- 11. PERMISSOES ADMINISTRATIVAS
-- ============================================================

create policy fipe_references_admin
on public.fipe_references
for all
using (public.is_admin())
with check (public.is_admin());

create policy vehicle_brands_admin
on public.vehicle_brands
for all
using (public.is_admin())
with check (public.is_admin());

create policy vehicle_models_admin
on public.vehicle_models
for all
using (public.is_admin())
with check (public.is_admin());

create policy vehicle_catalog_admin
on public.vehicle_catalog
for all
using (public.is_admin())
with check (public.is_admin());

create policy vehicle_fipe_prices_admin
on public.vehicle_fipe_prices
for all
using (public.is_admin())
with check (public.is_admin());

create policy vehicle_market_prices_admin
on public.vehicle_market_prices
for all
using (public.is_admin())
with check (public.is_admin());

create policy fipe_sync_runs_admin_read
on public.fipe_sync_runs
for select
using (public.is_admin());

-- ============================================================
-- 12. PERMISSOES DE LEITURA
-- ============================================================

grant select on
  public.fipe_references,
  public.vehicle_brands,
  public.vehicle_models,
  public.vehicle_catalog,
  public.vehicle_fipe_prices,
  public.vehicle_market_prices
to anon, authenticated;

grant select on public.fipe_sync_runs
to authenticated;

-- ============================================================
-- FIM DA MIGRATION 0002
-- YOUR SALES CARS
-- ============================================================

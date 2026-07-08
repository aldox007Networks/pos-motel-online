-- ============================================================
-- POS Motel en línea — Esquema de base de datos (Supabase)
-- Pegar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- Perfiles de usuario (cajeras y administradores)
create table if not exists perfiles (
  id uuid primary key references auth.users on delete cascade,
  usuario text unique not null,
  nombre text not null,
  rol text not null default 'cajera' check (rol in ('cajera','admin')),
  sucursal text not null default 'barcelona' check (sucursal in ('barcelona','amsterdam')),
  creado timestamptz default now()
);

-- Catálogo de productos (separado por sucursal)
create table if not exists productos (
  id uuid primary key default gen_random_uuid(),
  sucursal text not null check (sucursal in ('barcelona','amsterdam')),
  nombre text not null,
  codigo text not null,
  interno boolean default false,
  precio numeric not null default 0,
  stock integer not null default 0,
  stock_min integer not null default 0,
  stock_max integer not null default 0,
  rapido boolean default false,
  emoji text default '📦',
  creado timestamptz default now()
);
create unique index if not exists productos_suc_codigo on productos (sucursal, codigo);

-- Tickets de venta (solo efectivo)
create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  sucursal text not null check (sucursal in ('barcelona','amsterdam')),
  folio integer not null,
  fecha timestamptz default now(),
  items jsonb not null,
  total numeric not null default 0,
  cajera text,
  turno integer,
  cancelado boolean default false,
  corte_id uuid
);
create index if not exists tickets_suc_fecha on tickets (sucursal, fecha desc);
create index if not exists tickets_suc_corte on tickets (sucursal, corte_id);

-- Cortes de caja por turno
create table if not exists cortes (
  id uuid primary key default gen_random_uuid(),
  sucursal text not null check (sucursal in ('barcelona','amsterdam')),
  fecha timestamptz default now(),
  turno integer,
  cajera text,
  total numeric default 0,
  num_ventas integer default 0,
  cancelados integer default 0,
  folios jsonb,
  inventario jsonb
);
create index if not exists cortes_suc_fecha on cortes (sucursal, fecha desc);

-- Entradas de mercancía (resurtidos)
create table if not exists entradas (
  id uuid primary key default gen_random_uuid(),
  sucursal text not null check (sucursal in ('barcelona','amsterdam')),
  fecha timestamptz default now(),
  producto_id uuid,
  nombre text,
  cantidad integer not null,
  stock_anterior integer,
  stock_nuevo integer,
  usuario text,
  nota text
);
create index if not exists entradas_suc_fecha on entradas (sucursal, fecha desc);

-- ============================================================
-- Seguridad (RLS): solo usuarios autenticados pueden operar
-- ============================================================
alter table perfiles enable row level security;
alter table productos enable row level security;
alter table tickets enable row level security;
alter table cortes enable row level security;
alter table entradas enable row level security;

create policy "perfiles_autenticados" on perfiles
  for all to authenticated using (true) with check (true);

create policy "productos_autenticados" on productos
  for all to authenticated using (true) with check (true);

create policy "tickets_autenticados" on tickets
  for all to authenticated using (true) with check (true);

create policy "cortes_autenticados" on cortes
  for all to authenticated using (true) with check (true);

create policy "entradas_autenticados" on entradas
  for all to authenticated using (true) with check (true);

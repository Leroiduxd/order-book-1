# order-book-1


-- ===============================
-- BROKEX / SUPABASE - MVP SCHEMA
-- ===============================

-- ---------- ENUMS ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'trade_state') then
    create type trade_state as enum ('ORDER','OPEN','CLOSED','CANCELLED');
  end if;
  if not exists (select 1 from pg_type where typname = 'remove_reason') then
    create type remove_reason as enum ('CANCELLED','MARKET','SL','TP','LIQ');
  end if;
end$$;

-- ---------- TABLES ----------
create table if not exists public.assets (
  id           int4 primary key,
  symbol       text not null,
  tick_x6      int8 not null,              -- ex: 10000 => $0.01 (x1e6)
  lot_num      numeric default 1,          -- optionnel
  lot_den      numeric default 1,          -- optionnel
  created_at   timestamptz default now()
);

create table if not exists public.trades (
  id                int8 primary key,      -- id on-chain
  owner_addr        text not null,         -- 0x...
  asset_id          int4 not null references public.assets(id) on delete restrict,

  long_side         boolean not null,
  lots              int2 not null,
  leverage_x        int2 not null,         -- 1..100
  margin_usd6       int8 not null,

  state             trade_state not null,  -- ORDER | OPEN | CLOSED | CANCELLED

  entry_x6          int8 not null default 0,
  target_x6         int8 not null default 0,
  sl_x6             int8 not null default 0,
  tp_x6             int8 not null default 0,
  liq_x6            int8 not null default 0,

  opened_at         timestamptz default now(),
  executed_at       timestamptz,
  closed_at         timestamptz,
  cancelled_at      timestamptz,
  removed_reason    remove_reason,
  last_tx_hash      text,
  last_block_num    bigint,

  -- buckets (pré-calculés pour recherches par prix/tick)
  target_bucket     int8,
  sl_bucket         int8,
  tp_bucket         int8,
  liq_bucket        int8,

  constraint chk_state_entry
    check (
      (state='ORDER'     and entry_x6=0) or
      (state in ('OPEN','CLOSED') and entry_x6<>0) or
      (state='CANCELLED')
    )
);

create table if not exists public.trade_events (
  id              bigserial primary key,
  trade_id        int8 not null references public.trades(id) on delete cascade,
  evt             text not null,           -- 'Opened' | 'Executed' | 'StopsUpdated' | 'Removed'
  payload         jsonb not null,
  tx_hash         text,
  block_num       bigint,
  occurred_at     timestamptz not null default now()
);

-- ---------- INDEXES ----------
create index if not exists trades_owner_state_idx on public.trades(owner_addr, state);
create index if not exists trades_asset_state_idx on public.trades(asset_id, state);

-- Tick lookups (index partiels)
create index if not exists trades_target_bucket_idx on public.trades(asset_id, target_bucket) where state='ORDER';
create index if not exists trades_sl_bucket_idx     on public.trades(asset_id, sl_bucket)     where state='OPEN';
create index if not exists trades_tp_bucket_idx     on public.trades(asset_id, tp_bucket)     where state='OPEN';
create index if not exists trades_liq_bucket_idx    on public.trades(asset_id, liq_bucket)    where state='OPEN';

-- ---------- HELPERS (SQL functions) ----------
-- Calcule le bucket pour un prix en fonction du tick de l'asset.
create or replace function public.price_to_bucket(_asset_id int4, _price_x6 int8)
returns int8
language sql
stable
as $$
  select floor(_price_x6 / a.tick_x6)::int8
  from assets a
  where a.id = _asset_id
$$;

-- ---------- RPC LECTURE (ENDPOINTS) ----------

-- A) Par “tick” : retourne tous les IDs liés à ce prix/tick (ORDER/SL/TP/LIQ)
create or replace function public.get_ids_by_tick(
  in _asset_id int4,
  in _price_x6 int8
)
returns table(id int8, kind text)
language sql
stable
as $$
  with b as (select price_to_bucket(_asset_id, _price_x6) as bucket)
  -- ORDER (target)
  select t.id, 'ORDER'
  from trades t, b
  where t.asset_id=_asset_id and t.state='ORDER'
    and t.target_bucket = b.bucket

  union all
  -- SL (OPEN)
  select t.id, 'SL'
  from trades t, b
  where t.asset_id=_asset_id and t.state='OPEN' and t.sl_x6<>0
    and t.sl_bucket = b.bucket

  union all
  -- TP (OPEN)
  select t.id, 'TP'
  from trades t, b
  where t.asset_id=_asset_id and t.state='OPEN' and t.tp_x6<>0
    and t.tp_bucket = b.bucket

  union all
  -- LIQ (OPEN)
  select t.id, 'LIQ'
  from trades t, b
  where t.asset_id=_asset_id and t.state='OPEN' and t.liq_x6<>0
    and t.liq_bucket = b.bucket
$$;

-- B) IDs d’un trader groupés par état (JSON)
create or replace function public.get_trader_ids_grouped(
  in _owner_addr text
)
returns jsonb
language sql
stable
as $$
select jsonb_build_object(
  'order',     coalesce((select jsonb_agg(id order by id) from trades where owner_addr=_owner_addr and state='ORDER'), '[]'::jsonb),
  'open',      coalesce((select jsonb_agg(id order by id) from trades where owner_addr=_owner_addr and state='OPEN'), '[]'::jsonb),
  'closed',    coalesce((select jsonb_agg(id order by id) from trades where owner_addr=_owner_addr and state='CLOSED'), '[]'::jsonb),
  'cancelled', coalesce((select jsonb_agg(id order by id) from trades where owner_addr=_owner_addr and state='CANCELLED'), '[]'::jsonb)
);
$$;

-- C) Détails d’une position (retourne la ligne complète)
create or replace function public.get_trade_detail(
  in _id int8
)
returns trades
language sql
stable
as $$
  select * from trades where id=_id;
$$;

-- ---------- RPC INGESTION (facultatif mais pratique) ----------
-- Appelées par ton indexer quand il lit les events on-chain.

-- 1) Opened (market ou limit)
-- entry_or_target_x6 = entry si state=OPEN, target si state=ORDER
create or replace function public.ingest_opened(
  _id int8,
  _owner_addr text,
  _asset_id int4,
  _long_side boolean,
  _lots int2,
  _leverage_x int2,
  _margin_usd6 int8,
  _state trade_state,              -- 'ORDER' ou 'OPEN'
  _entry_or_target_x6 int8,
  _sl_x6 int8,
  _tp_x6 int8,
  _liq_x6 int8,
  _tx_hash text,
  _block_num bigint
)
returns void
language plpgsql
volatile
as $$
begin
  insert into public.trades as t (
    id, owner_addr, asset_id, long_side, lots, leverage_x, margin_usd6,
    state, entry_x6, target_x6, sl_x6, tp_x6, liq_x6,
    opened_at, last_tx_hash, last_block_num,
    target_bucket, sl_bucket, tp_bucket, liq_bucket
  )
  values (
    _id, _owner_addr, _asset_id, _long_side, _lots, _leverage_x, _margin_usd6,
    _state,
    case when _state='OPEN' then _entry_or_target_x6 else 0 end,
    case when _state='ORDER' then _entry_or_target_x6 else 0 end,
    _sl_x6, _tp_x6, _liq_x6,
    now(), _tx_hash, _block_num,
    case when _state='ORDER' and _entry_or_target_x6<>0 then price_to_bucket(_asset_id, _entry_or_target_x6) else null end,
    case when _sl_x6<>0 then price_to_bucket(_asset_id, _sl_x6) else null end,
    case when _tp_x6<>0 then price_to_bucket(_asset_id, _tp_x6) else null end,
    case when _liq_x6<>0 then price_to_bucket(_asset_id, _liq_x6) else null end
  )
  on conflict (id) do update
  set state          = excluded.state,
      entry_x6       = excluded.entry_x6,
      target_x6      = excluded.target_x6,
      sl_x6          = excluded.sl_x6,
      tp_x6          = excluded.tp_x6,
      liq_x6         = excluded.liq_x6,
      last_tx_hash   = excluded.last_tx_hash,
      last_block_num = excluded.last_block_num,
      target_bucket  = excluded.target_bucket,
      sl_bucket      = excluded.sl_bucket,
      tp_bucket      = excluded.tp_bucket,
      liq_bucket     = excluded.liq_bucket;
end
$$;

-- 2) Executed (LIMIT -> OPEN)
create or replace function public.ingest_executed(
  _id int8,
  _entry_x6 int8,
  _tx_hash text,
  _block_num bigint
)
returns void
language sql
volatile
as $$
  update public.trades
  set state='OPEN',
      entry_x6 = _entry_x6,
      executed_at = coalesce(executed_at, now()),
      last_tx_hash=_tx_hash, last_block_num=_block_num
  where id=_id;
$$;

-- 3) StopsUpdated
create or replace function public.ingest_stops_updated(
  _id int8,
  _sl_x6 int8,
  _tp_x6 int8,
  _tx_hash text,
  _block_num bigint
)
returns void
language plpgsql
volatile
as $$
declare
  _asset_id int4;
begin
  select asset_id into _asset_id from trades where id=_id;
  update public.trades
  set sl_x6=_sl_x6,
      tp_x6=_tp_x6,
      sl_bucket = case when _sl_x6<>0 then price_to_bucket(_asset_id, _sl_x6) else null end,
      tp_bucket = case when _tp_x6<>0 then price_to_bucket(_asset_id, _tp_x6) else null end,
      last_tx_hash=_tx_hash, last_block_num=_block_num
  where id=_id;
end
$$;

-- 4) Removed (CLOSED ou CANCELLED)
create or replace function public.ingest_removed(
  _id int8,
  _reason remove_reason,      -- 'CANCELLED' | 'MARKET' | 'SL' | 'TP' | 'LIQ'
  _exec_x6 int8,
  _pnl_usd6 numeric,
  _tx_hash text,
  _block_num bigint
)
returns void
language sql
volatile
as $$
  update public.trades
  set state = case when _reason='CANCELLED' then 'CANCELLED'::trade_state else 'CLOSED'::trade_state end,
      removed_reason = _reason,
      closed_at   = case when _reason<>'CANCELLED' then now() else null end,
      cancelled_at= case when _reason='CANCELLED' then now() else null end,
      last_tx_hash=_tx_hash, last_block_num=_block_num
  where id=_id;
$$;

-- ---------- RLS (Row-Level Security) ----------
alter table public.assets       enable row level security;
alter table public.trades       enable row level security;
alter table public.trade_events enable row level security;

-- Lecture publique (lisible par ton backend / indexer / front)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='assets' and policyname='read_assets_public') then
    create policy read_assets_public on public.assets
      for select using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='trades' and policyname='read_trades_public') then
    create policy read_trades_public on public.trades
      for select using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='trade_events' and policyname='read_events_public') then
    create policy read_events_public on public.trade_events
      for select using (true);
  end if;
end$$;

-- (Optionnel) si tu veux insérer/mettre à jour uniquement depuis le service key:
--   - garde l’écriture côté backend (no RLS policy for insert/update), ou
--   - crée des policies ciblées avec auth.uid() si tu relies à des comptes.

-- ===============================
-- FIN DU BLOC
-- ===============================


UPDATE public.stop_buckets sb
SET lots = p.lots,
    side = NOT p.long_side
FROM public.positions p
WHERE p.id = sb.position_id;

-- 3️⃣ Ajout d'index pour accélérer les requêtes par side
CREATE INDEX IF NOT EXISTS order_buckets_asset_bucket_side_idx
  ON public.order_buckets(asset_id, bucket_id, side);

CREATE INDEX IF NOT EXISTS stop_buckets_asset_bucket_side_idx
  ON public.stop_buckets(asset_id, bucket_id, side);
  
  
-- =========================================
-- 1) Table d’agrégats expos longs/short par asset
-- =========================================
create table if not exists public.exposure_agg (
  asset_id              int4    not null,
  side                  boolean not null,      -- true=LONG, false=SHORT
  sum_lots              int8    not null default 0,
  sum_entry_x6_lots     numeric(38,0) not null default 0,  -- somme(entry_x6 * lots)
  sum_leverage_lots     numeric(38,0) not null default 0,  -- somme(leverage_x * lots)
  sum_liq_x6_lots       numeric(38,0) not null default 0,  -- somme(liq_x6 * lots) (si liq_x6>0)
  sum_liq_lots          int8    not null default 0,        -- somme(lots) pris en compte pour avg liq
  positions_count       int8    not null default 0,
  primary key (asset_id, side)
);

-- =========================================
-- 2) Vue de lecture (métriques calculées)
-- =========================================
create or replace view public.exposure_metrics as
select
  ea.asset_id,
  case when ea.side then 'LONG' else 'SHORT' end as side_label,
  ea.sum_lots,
  case when ea.sum_lots > 0
       then floor(ea.sum_entry_x6_lots / ea.sum_lots)
       else null end                          as avg_entry_x6,
  case when ea.sum_lots > 0
       then (ea.sum_leverage_lots::numeric / ea.sum_lots)::numeric
       else null end                          as avg_leverage_x,
  case when ea.sum_liq_lots > 0
       then floor(ea.sum_liq_x6_lots / ea.sum_liq_lots)
       else null end                          as avg_liq_x6,
  ea.positions_count
from public.exposure_agg ea;

-- =========================================
-- 3) Fonction helper: appliquer un delta (+/-) sur les agrégats
--    sign = +1 pour ajouter, -1 pour retirer
-- =========================================
create or replace function public.exposure_apply(
  _asset_id   int4,
  _side       boolean,
  _lots       int8,
  _entry_x6   int8,
  _lev_x      int4,
  _liq_x6     int8,
  _sign       int4
)
returns void
language plpgsql
as $$
declare
  v_lots           int8 := coalesce(_lots, 0);
  v_entry_x6       int8 := coalesce(_entry_x6, 0);
  v_lev_x          int4 := coalesce(_lev_x, 0);
  v_liq_x6         int8 := coalesce(_liq_x6, 0);
  d_sum_lots       int8;
  d_sum_entry_lots numeric(38,0);
  d_sum_lev_lots   numeric(38,0);
  d_sum_liq_lots   numeric(38,0);
  d_liq_lots       int8;
  d_count          int8;
begin
  if v_lots = 0 then
    return;
  end if;

  d_sum_lots       := _sign * v_lots;
  d_sum_entry_lots := _sign * (v_entry_x6::numeric * v_lots::numeric);
  d_sum_lev_lots   := _sign * (v_lev_x::numeric * v_lots::numeric);
  d_sum_liq_lots   := case when v_liq_x6 > 0 then _sign * (v_liq_x6::numeric * v_lots::numeric) else 0 end;
  d_liq_lots       := case when v_liq_x6 > 0 then _sign * v_lots else 0 end;
  d_count          := _sign * 1;

  insert into public.exposure_agg as ea (
    asset_id, side, sum_lots, sum_entry_x6_lots, sum_leverage_lots, sum_liq_x6_lots, sum_liq_lots, positions_count
  )
  values (_asset_id, _side, d_sum_lots, d_sum_entry_lots, d_sum_lev_lots, d_sum_liq_lots, d_liq_lots, d_count)
  on conflict (asset_id, side) do update
  set sum_lots          = ea.sum_lots          + excluded.sum_lots,
      sum_entry_x6_lots = ea.sum_entry_x6_lots + excluded.sum_entry_x6_lots,
      sum_leverage_lots = ea.sum_leverage_lots + excluded.sum_leverage_lots,
      sum_liq_x6_lots   = ea.sum_liq_x6_lots   + excluded.sum_liq_x6_lots,
      sum_liq_lots      = ea.sum_liq_lots      + excluded.sum_liq_lots,
      positions_count   = ea.positions_count   + excluded.positions_count;
end
$$;

-- =========================================
-- 4) Trigger: maintenir exposure_agg sur INSERT/UPDATE/DELETE de positions
--    Règle: on agrège UNIQUEMENT les lignes state=1 (OPEN)
-- =========================================
create or replace function public.positions_exposure_trg()
returns trigger
language plpgsql
as $$
begin
  -- INSERT: si la nouvelle ligne est OPEN, on ajoute
  if (tg_op = 'INSERT') then
    if new.state = 1 then
      perform public.exposure_apply(new.asset_id, new.long_side, new.lots, new.entry_x6, new.leverage_x, new.liq_x6, +1);
    end if;
    return new;
  end if;

  -- UPDATE: on retire l'ancienne contrib si elle était OPEN, puis on ajoute la nouvelle si elle est OPEN
  if (tg_op = 'UPDATE') then
    if coalesce(old.state, -1) = 1 then
      perform public.exposure_apply(old.asset_id, old.long_side, old.lots, old.entry_x6, old.leverage_x, old.liq_x6, -1);
    end if;
    if coalesce(new.state, -1) = 1 then
      perform public.exposure_apply(new.asset_id, new.long_side, new.lots, new.entry_x6, new.leverage_x, new.liq_x6, +1);
    end if;
    return new;
  end if;

  -- DELETE: si l'ancienne ligne était OPEN, on retire
  if (tg_op = 'DELETE') then
    if old.state = 1 then
      perform public.exposure_apply(old.asset_id, old.long_side, old.lots, old.entry_x6, old.leverage_x, old.liq_x6, -1);
    end if;
    return old;
  end if;

  return null;
end
$$;

drop trigger if exists trg_positions_exposure on public.positions;
create trigger trg_positions_exposure
after insert or update or delete on public.positions
for each row execute function public.positions_exposure_trg();

-- =========================================
-- 5) Backfill initial (optionnel si tu as déjà des positions OPEN)
-- =========================================
-- Remet à zéro et recalcule l’état actuel à partir des positions déjà OPEN.
-- (décommente si nécessaire)
-- truncate table public.exposure_agg;
-- insert into public.exposure_agg (asset_id, side, sum_lots, sum_entry_x6_lots, sum_leverage_lots, sum_liq_x6_lots, sum_liq_lots, positions_count)
-- select
--   p.asset_id,
--   p.long_side as side,
--   sum(p.lots)::int8 as sum_lots,
--   sum((p.entry_x6::numeric) * (p.lots::numeric)) as sum_entry_x6_lots,
--   sum((p.leverage_x::numeric) * (p.lots::numeric)) as sum_leverage_lots,
--   sum(case when p.liq_x6 > 0 then (p.liq_x6::numeric) * (p.lots::numeric) else 0 end) as sum_liq_x6_lots,
--   sum(case when p.liq_x6 > 0 then p.lots else 0 end)::int8 as sum_liq_lots,
--   count(*)::int8 as positions_count
-- from public.positions p
-- where p.state = 1
-- group by p.asset_id, p.long_side;

-- =========================================
-- 6) RLS lecture publique (si tu exposes via PostgREST)
-- =========================================
alter table public.exposure_agg enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='exposure_agg' and policyname='read_exposure_agg_public'
  ) then
    create policy read_exposure_agg_public on public.exposure_agg
      for select using (true);
  end if;
end$$;

-- (Vue: pas besoin de policy, elle hérite des droits sous-jacents)



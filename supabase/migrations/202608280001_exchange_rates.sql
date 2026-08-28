begin;

-- Epica 3 slice 1: public.exchange_rates and append-only rate history.
--
-- Exchange rates record conversion factors between pairs of currencies within a
-- workspace. The contract authority defines ExchangeRate with id, baseCurrency,
-- quoteCurrency, rate, effectiveAt, source, and manual.
--
-- Requirements driving the design:
-- - FR-FX-004 "Tasas históricas": historical rates MUST NOT be overwritten
--   retroactively. The table is therefore strictly APPEND-ONLY: grant SELECT
--   and INSERT, never UPDATE or DELETE.
-- - FR-FX-007 "Tasas manuales": a user may enter a manual rate, recorded via
--   the manual boolean flag and source text identifier.
-- - FR-FX-008: the UI surfaces source, date (effective_at), and applied rate.
-- - Base and quote currency check: identical currencies (base_currency = quote_currency)
--   are meaningless and unrepresentable.
-- - Unique constraint on (workspace_id, base_currency, quote_currency, effective_at):
--   permits a complete time-series history per currency pair while preventing duplicate
--   timestamps for the same pair in the same workspace.

create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  -- on delete cascade matches the house convention for workspace-scoped financial
  -- tables (accounts, ledger_postings, transfers all use it). Note the deliberate
  -- limit it places on FR-FX-004: rate history is preserved against retroactive
  -- OVERWRITING, not against deletion of the owning workspace, which removes every
  -- financial row of that workspace alike.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) not null check (quote_currency ~ '^[A-Z]{3}$'),
  -- Although the OpenAPI DecimalString pattern syntactically admits a negative number,
  -- a negative exchange rate is meaningless, so the database strictly refuses it.
  -- The constraint is NAMED so a test can pin THIS check rather than pass on any
  -- unrelated check violation the row might also trigger.
  rate numeric not null
    constraint exchange_rates_rate_positive_check check (rate > 0),
  effective_at timestamptz not null,
  source text not null,
  manual boolean not null default true,
  -- CreateManualExchangeRateRequest accepts an optional notes field (max 500 chars).
  -- Without this column the API would accept that field and silently discard it,
  -- losing user input. ExchangeRate does not return notes, so the read projection
  -- deliberately omits it; the column exists so the submitted value is preserved.
  notes text
    constraint exchange_rates_notes_length_check
    check (notes is null or length(notes) <= 500),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Base and quote currencies must be distinct.
  constraint exchange_rates_distinct_currencies_check
    check (base_currency <> quote_currency),
  -- Unique constraint per workspace, pair, and effective timestamp permits full history.
  constraint exchange_rates_workspace_pair_effective_at_key
    unique (workspace_id, base_currency, quote_currency, effective_at)
);

-- Lookup index for keyset and latest rate queries per currency pair:
create index exchange_rates_workspace_pair_latest_idx
  on public.exchange_rates (workspace_id, base_currency, quote_currency, effective_at desc);

comment on table public.exchange_rates is 'Workspace exchange rates. fitness:financial';

alter table public.exchange_rates enable row level security;
alter table public.exchange_rates force row level security;

-- Grants: COLUMN-SCOPED insert grants for least privilege.
-- In accordance with FR-FX-004, exchange rates are strictly APPEND-ONLY financial history.
-- Therefore, we grant SELECT and INSERT only — NO UPDATE grant, NO DELETE grant, and
-- NO update or delete policies exist on this table.
grant select on public.exchange_rates to savia_application;
grant insert (workspace_id, base_currency, quote_currency, rate,
              effective_at, source, manual, notes, created_by)
  on public.exchange_rates to savia_application;

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_exchange_rate
  on public.exchange_rates
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(exchange_rates.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_exchange_rate
  on public.exchange_rates
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(exchange_rates.workspace_id)
      in ('owner', 'administrator', 'editor')
    and exchange_rates.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

commit;

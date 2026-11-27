import type { TransactionClient } from '../platform/pg-transaction.js';

interface Charge extends Record<string, unknown> {
  readonly key: string;
  readonly id: string;
  readonly payeeName: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly at: string;
}

interface FrequencyChange extends Record<string, unknown> {
  readonly resourceId: string;
  readonly previousFrequency: string;
  readonly frequency: string;
  readonly payeeName: string;
}

const DAY_MS = 86_400_000;
const CADENCES = [
  { frequency: 'weekly', min: 5, max: 9, months: 0 },
  { frequency: 'monthly', min: 25, max: 35, months: 1 },
  { frequency: 'yearly', min: 350, max: 380, months: 12 },
] as const;

function nextDate(last: Date, months: number): Date {
  if (months === 0) return new Date(last.getTime() + 7 * DAY_MS);
  const next = new Date(last);
  next.setUTCMonth(next.getUTCMonth() + months + 1, 0);
  next.setUTCDate(Math.min(next.getUTCDate(), last.getUTCDate()));
  return next;
}

export async function updateDetectedSubscriptions(
  client: TransactionClient,
  workspaceId: string,
  subject: string,
  cutoff: Date,
): Promise<readonly FrequencyChange[]> {
  // Keep only the three latest finalized charges per account, currency, payee,
  // and normalized description. Distinct purchases at one payee stay separate.
  const { rows } = await client.query<Charge>(
    `with charges as (
       select t.id, t.occurred_at, abs(t.amount_minor::numeric)::text as "amountMinor", t.currency,
              left(coalesce(p.name, label.description), 120) as "payeeName",
              jsonb_build_array(t.account_id, t.currency, t.payee_id, lower(label.description)) as series
       from public.transactions t
       left join public.payees p on p.workspace_id = t.workspace_id and p.id = t.payee_id
       cross join lateral (select nullif(btrim(regexp_replace(t.description, '[[:space:]]+', ' ', 'g')), '') as description) label
       where t.workspace_id = $1 and t.type = 'expense' and t.status in ('confirmed', 'reconciled')
         and (t.payee_id is not null or label.description is not null)
         and t.amount_minor <> 0 and t.amount_minor > '-9223372036854775808'::bigint
         and t.occurred_at between $2::timestamptz - interval '1140 days' and $2::timestamptz
     ), ranked as (
       select *, row_number() over (partition by series order by occurred_at desc, id desc) as sample,
              count(*) over (partition by series) as observations
       from charges
     )
     select encode(sha256(convert_to(series::text, 'UTF8')), 'hex') as key,
            id, "amountMinor", currency, "payeeName",
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
     from ranked where observations >= 3 and sample <= 3 order by key, sample`,
    [workspaceId, cutoff.toISOString()],
  );
  const frequencyChanges: FrequencyChange[] = [];
  for (let index = 0; index < rows.length; index += 3) {
    const [latest, previous, first] = rows.slice(index, index + 3);
    if (!latest || !previous || !first) continue;
    const last = new Date(latest.at);
    const gaps = [
      last.getTime() - Date.parse(previous.at),
      Date.parse(previous.at) - Date.parse(first.at),
    ];
    const cadence = CADENCES.find(({ min, max }) =>
      gaps.every((diff) => diff >= min * DAY_MS && diff <= max * DAY_MS),
    );
    if (
      cadence === undefined ||
      cutoff.getTime() - last.getTime() > 2 * cadence.max * DAY_MS
    )
      continue;
    const amounts = [latest, previous, first].map(({ amountMinor }) =>
      BigInt(amountMinor),
    );
    const similar = amounts.every((a) =>
      amounts.every((b) => a * 100n <= b * 120n),
    );

    // Similarity gates proposals, not changes to an already tracked series.
    // Lock its prior state so that a concurrent sweep can't emit a stale cadence change.
    const { rows: changes } = await client.query<FrequencyChange>(
      `with prior as (
         select frequency from public.subscriptions where workspace_id = $1 and detection_key = $3
         for update
       ), saved as (
         insert into public.subscriptions as s
           (workspace_id, created_by, status, detection_key, detection_observed_at, detection_observation_id,
            payee_name, current_currency, current_amount_minor, previous_currency, previous_amount_minor, frequency, next_expected_at)
         select $1,$2,'detected',$3,$4,$5,$6,$7,$8,$7,$9,$10,$11
         where $12::boolean or exists (select 1 from prior)
         on conflict (workspace_id, detection_key) do update set
           detection_observed_at = excluded.detection_observed_at,
           detection_observation_id = excluded.detection_observation_id,
           payee_name = excluded.payee_name, current_amount_minor = excluded.current_amount_minor,
           previous_amount_minor = s.current_amount_minor, frequency = excluded.frequency,
           next_expected_at = excluded.next_expected_at
         where exists (select 1 from prior) and s.status in ('detected','confirmed') and
           (s.detection_observed_at, s.detection_observation_id) < (excluded.detection_observed_at, excluded.detection_observation_id)
         returning s.frequency, s.payee_name, md5(jsonb_build_array(s.id, s.detection_observation_id)::text)::uuid as event_id
       )
       select saved.event_id as "resourceId", saved.frequency, saved.payee_name as "payeeName", prior.frequency as "previousFrequency"
       from saved cross join prior where saved.frequency <> prior.frequency`,
      [
        workspaceId,
        subject,
        latest.key,
        latest.at,
        latest.id,
        latest.payeeName,
        latest.currency,
        latest.amountMinor,
        previous.amountMinor,
        cadence.frequency,
        nextDate(last, cadence.months).toISOString(),
        similar,
      ],
    );
    frequencyChanges.push(...changes);
  }
  return frequencyChanges;
}

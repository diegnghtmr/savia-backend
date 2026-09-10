import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUDGETS_PORT,
  type BudgetsPort,
} from '../../src/budgets/budget.port.js';
import { BudgetsModule } from '../../src/budgets/budgets.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { fixture, IDS, command } from './budget-fixtures.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('budget allocations against disposable PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: NestFastifyApplication;
  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });
    f = await fixture(url);
    const moduleRef = await Test.createTestingModule({
      imports: [BudgetsModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: IDS.user };
          if (token === 'other-token') return { subject: IDS.otherUser };
          throw new Error('token rejected');
        },
      })
      .overrideProvider(BUDGETS_PORT)
      .useValue(f.service satisfies BudgetsPort)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
    await f.cleanup();
    await f.close();
  });

  let sequence = 7100;
  const key = () =>
    `00000000-0000-0000-0000-${String(sequence++).padStart(12, '0')}`;
  const create = async (
    workspace: string = IDS.workspace,
    subject: string = IDS.user,
  ) => {
    const result = await f.service.createBudget(
      subject,
      workspace,
      command(),
      key(),
    );
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('budget setup failed');
    return result.budget;
  };
  const put = (
    id: string,
    body: unknown,
    extra: Record<string, string> = {},
    token = 'owner-token',
  ) =>
    app.inject({
      method: 'PUT',
      url: `/v1/budgets/${id}/allocations`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-workspace-id': IDS.workspace,
        'idempotency-key': key(),
        'content-type': 'application/json',
        ...extra,
      },
      payload: JSON.stringify(body),
    });
  const allocation = (
    categoryId: string = IDS.category,
    amountMinor = '1000',
    policy = 'none',
    target?: string | null,
  ) => ({
    categoryId,
    planned: { amountMinor, currency: 'USD' },
    rolloverPolicy: policy,
    ...(target === undefined ? {} : { rolloverTargetId: target }),
  });

  it('1 sets allocations and returns the full budget', async () => {
    const created = await f.service.createBudget(
      IDS.user,
      IDS.workspace,
      command(),
      '00000000-0000-0000-0000-000000007001',
    );
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/budgets/${created.budget.id}/allocations`,
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': IDS.workspace,
        'idempotency-key': '00000000-0000-0000-0000-000000007002',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        allocations: [
          {
            categoryId: IDS.category,
            planned: { amountMinor: '1000', currency: 'USD' },
            rolloverPolicy: 'none',
          },
        ],
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().allocations).toHaveLength(1);
  });

  it('2 persists the requested allocation columns exactly', async () => {
    const budget = await create();
    const response = await put(budget.id, { allocations: [allocation()] });
    expect(response.statusCode).toBe(200);
    const rows = await f.admin.query(
      'select category_id::text,planned_minor::text,rollover_policy,rollover_target_id::text from public.budget_allocations where budget_id=$1',
      [budget.id],
    );
    expect(rows.rows).toEqual([
      {
        category_id: IDS.category,
        planned_minor: '1000',
        rollover_policy: 'none',
        rollover_target_id: null,
      },
    ]);
  });
  it('3 replaces and deletes omitted categories', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,1),($1,$2,$4,2)',
      [IDS.workspace, budget.id, IDS.category, IDS.statusCategory],
    );
    expect(
      (await put(budget.id, { allocations: [allocation()] })).statusCode,
    ).toBe(200);
    expect(
      (
        await f.admin.query(
          'select category_id::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ category_id: IDS.category }]);
  });
  it('4 clears all allocations with an empty array', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,1)',
      [IDS.workspace, budget.id, IDS.category],
    );
    expect((await put(budget.id, { allocations: [] })).statusCode).toBe(200);
    expect(
      (
        await f.admin.query(
          'select 1 from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('5 increments version exactly once', async () => {
    const budget = await create();
    const response = await put(budget.id, { allocations: [] });
    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(2);
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
  });
  it('6 computes available from planned minus actual', async () => {
    const budget = await create();
    await f.insertPosting({
      id: key(),
      transactionId: key(),
      amountMinor: 250,
      currency: 'USD',
      status: 'confirmed',
      occurredAt: '2026-01-15T12:00:00Z',
    });
    const response = await put(budget.id, {
      allocations: [allocation(IDS.category, '1000')],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().allocations[0]).toMatchObject({
      actual: { amountMinor: '250' },
      available: { amountMinor: '750' },
    });
  });
  it('7 converts foreign-currency actual through the shared read path', async () => {
    const budget = await create();
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '2',
      effectiveAt: '2026-01-01T00:00:00Z',
    });
    const account = await f.insertAccount({ currency: 'EUR' });
    await f.insertPosting({
      id: key(),
      transactionId: key(),
      amountMinor: 250,
      currency: 'EUR',
      status: 'confirmed',
      occurredAt: '2026-01-15T12:00:00Z',
      accountId: account,
      categoryId: IDS.statusCategory,
    });
    const response = await put(budget.id, {
      allocations: [allocation(IDS.statusCategory)],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().allocations[0].actual.amountMinor).toBe('500');
  });
  it('8 rejects planned currency mismatch without writes', async () => {
    const budget = await create();
    const response = await put(budget.id, {
      allocations: [
        { ...allocation(), planned: { amountMinor: '1', currency: 'EUR' } },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(
      (
        await f.admin.query(
          'select 1 from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('9 rejects duplicate categories', async () => {
    const budget = await create();
    const response = await put(budget.id, {
      allocations: [allocation(), allocation()],
    });
    expect(response.statusCode).toBe(422);
    expect(
      (
        await f.admin.query(
          'select 1 from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('10 rejects unknown and real foreign categories', async () => {
    const budget = await create();
    expect(
      (
        await put(budget.id, {
          allocations: [allocation('00000000-0000-0000-0000-000000009999')],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await put(budget.id, { allocations: [allocation(IDS.otherCategory)] }))
        .statusCode,
    ).toBe(422);
  });
  it('11 validates to_category targets and workspace containment', async () => {
    const budget = await create();
    expect(
      (
        await put(budget.id, {
          allocations: [allocation(IDS.category, '1', 'to_category')],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await put(budget.id, {
          allocations: [
            allocation(
              IDS.category,
              '1',
              'to_category',
              '00000000-0000-0000-0000-000000009999',
            ),
          ],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await put(budget.id, {
          allocations: [
            allocation(IDS.category, '1', 'to_category', IDS.otherCategory),
          ],
        })
      ).statusCode,
    ).toBe(422);
  });
  it('12 rejects to_fund targets', async () => {
    const budget = await create();
    expect(
      (
        await put(budget.id, {
          allocations: [allocation(IDS.category, '1', 'to_fund', IDS.category)],
        })
      ).statusCode,
    ).toBe(422);
  });
  it('13 rejects targets for non-target policies', async () => {
    const budget = await create();
    for (const policy of ['none', 'surplus', 'deficit', 'both', 'to_savings'])
      expect(
        (
          await put(budget.id, {
            allocations: [allocation(IDS.category, '1', policy, IDS.category)],
          })
        ).statusCode,
      ).toBe(422);
  });
  it('14 accepts a same-workspace to_category target', async () => {
    const budget = await create();
    const response = await put(budget.id, {
      allocations: [
        allocation(IDS.category, '1', 'to_category', IDS.statusCategory),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().allocations[0].rolloverTargetId).toBe(
      IDS.statusCategory,
    );
    expect(
      (
        await f.admin.query(
          'select rollover_target_id::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ rollover_target_id: IDS.statusCategory }]);
  });
  it('15 enforces the allocation count limit and accepts exactly the limit', async () => {
    const budget = await create();
    const tooMany = Array.from({ length: 1001 }, (_, i) =>
      allocation(
        '00000000-0000-0000-0000-' + String(8000 + i).padStart(12, '0'),
      ),
    );
    expect((await put(budget.id, { allocations: tooMany })).statusCode).toBe(
      422,
    );
    const categories = (
      await f.admin.query(
        "insert into public.categories(id,workspace_id,parent_id,name,kind,created_by) select gen_random_uuid(),$1,null,'Limit ' || n,'expense',$2 from generate_series(1,1000) n returning id::text",
        [IDS.workspace, IDS.user],
      )
    ).rows.map((row) => row.id as string);
    expect(
      (
        await put(budget.id, {
          allocations: categories.map((id) => allocation(id, '1')),
        })
      ).statusCode,
    ).toBe(200);
  });
  it('16 rejects unknown properties at both levels', async () => {
    const budget = await create();
    expect(
      (await put(budget.id, { extra: true, allocations: [] })).statusCode,
    ).toBe(422);
    expect(
      (
        await put(budget.id, {
          allocations: [{ ...allocation(), extra: true }],
        })
      ).statusCode,
    ).toBe(422);
  });
  it('17 requires allocations', async () => {
    const budget = await create();
    expect((await put(budget.id, {})).statusCode).toBe(422);
  });
  it('18 honors If-Match semantics', async () => {
    const budget = await create();
    const initial = await put(budget.id, {
      allocations: [allocation()],
    });
    expect(initial.statusCode).toBe(200);
    const stale = await put(
      budget.id,
      { allocations: [] },
      { 'if-match': '"1"' },
    );
    expect(stale.statusCode).toBe(412);
    expect(
      (
        await f.admin.query(
          'select planned_minor::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ planned_minor: '1000' }]);
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
    expect(
      (await put(budget.id, { allocations: [] }, { 'if-match': 'bad' }))
        .statusCode,
    ).toBe(400);
    expect((await put(budget.id, { allocations: [] })).statusCode).toBe(200);
  });
  it('19 returns 404 for a real foreign budget before If-Match', async () => {
    const foreign = await create(IDS.otherWorkspace, IDS.otherUser);
    expect(
      (await put(foreign.id, { allocations: [] }, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(404);
  });
  it('20 returns 404 for an unknown budget', async () => {
    expect(
      (await put('00000000-0000-0000-0000-000000009999', { allocations: [] }))
        .statusCode,
    ).toBe(404);
  });
  it('21 replays idempotently', async () => {
    const budget = await create();
    const idempotencyKey = key();
    const options = {
      method: 'PUT' as const,
      url: `/v1/budgets/${budget.id}/allocations`,
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': IDS.workspace,
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ allocations: [allocation()] }),
    };
    const first = await app.inject(options);
    const second = await app.inject(options);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
    expect(
      (
        await f.admin.query(
          'select category_id::text, planned_minor::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ category_id: IDS.category, planned_minor: '1000' }]);
  });
  it('22 conflicts on a changed body or precondition', async () => {
    const budget = await create();
    const idempotencyKey = key();
    const headers = {
      authorization: 'Bearer owner-token',
      'x-workspace-id': IDS.workspace,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    };
    const first = await app.inject({
      method: 'PUT',
      url: `/v1/budgets/${budget.id}/allocations`,
      headers,
      payload: JSON.stringify({ allocations: [] }),
    });
    expect(first.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/budgets/${budget.id}/allocations`,
          headers,
          payload: JSON.stringify({ allocations: [allocation()] }),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/budgets/${budget.id}/allocations`,
          headers: { ...headers, 'if-match': '*' },
          payload: JSON.stringify({ allocations: [] }),
        })
      ).statusCode,
    ).toBe(409);
  });
  it('23 returns 401 and 403', async () => {
    const budget = await create();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/budgets/${budget.id}/allocations`,
          headers: {
            'x-workspace-id': IDS.workspace,
            'idempotency-key': key(),
            'content-type': 'application/json',
          },
          payload: '{"allocations":[]}',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await put(budget.id, { allocations: [] }, {}, 'other-token')).statusCode,
    ).toBe(403);
  });
  it('24 returns 400 for every declared transport error', async () => {
    const budget = await create();
    const base = {
      authorization: 'Bearer owner-token',
      'x-workspace-id': IDS.workspace,
      'idempotency-key': key(),
      'content-type': 'application/json',
    };
    const withoutWorkspace = {
      authorization: base.authorization,
      'idempotency-key': base['idempotency-key'],
      'content-type': base['content-type'],
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/budgets/${budget.id}/allocations`,
          headers: base,
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/budgets/${budget.id}/allocations`,
          headers: withoutWorkspace,
          payload: '{"allocations":[]}',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/budgets/${budget.id}/allocations`,
          headers: { ...base, 'x-workspace-id': 'bad' },
          payload: '{"allocations":[]}',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/budgets/not-uuid/allocations',
          headers: base,
          payload: '{"allocations":[]}',
        })
      ).statusCode,
    ).toBe(400);
  });
  it('25 rolls back when insertion fails after the replacement starts', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,77)',
      [IDS.workspace, budget.id, IDS.category],
    );
    await f.admin.query(
      "create or replace function public.fail_budget_allocation_insert() returns trigger language plpgsql as $$ begin raise exception 'forced allocation failure'; end $$; create trigger fail_budget_allocation_insert before insert on public.budget_allocations for each row execute function public.fail_budget_allocation_insert()",
    );
    try {
      expect(
        (
          await put(budget.id, {
            allocations: [allocation(IDS.statusCategory)],
          })
        ).statusCode,
      ).toBe(500);
    } finally {
      await f.admin.query(
        'drop trigger fail_budget_allocation_insert on public.budget_allocations; drop function public.fail_budget_allocation_insert()',
      );
    }
    expect(
      (
        await f.admin.query(
          'select category_id::text,planned_minor::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ category_id: IDS.category, planned_minor: '77' }]);
  });
  it('26 applies RLS to direct reads and deletes for a non-member', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,1)',
      [IDS.workspace, budget.id, IDS.category],
    );
    const client = await f.admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query(`select set_config('app.subject_id',$1,true)`, [
        IDS.otherUser,
      ]);
      expect(
        (
          await client.query(
            'select id from public.budget_allocations where budget_id=$1',
            [budget.id],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await client.query(
            'delete from public.budget_allocations where budget_id=$1',
            [budget.id],
          )
        ).rowCount,
      ).toBe(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('27 rejects an empty planned currency without deleting stored allocations', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,77)',
      [IDS.workspace, budget.id, IDS.category],
    );
    const response = await put(budget.id, {
      allocations: [
        { ...allocation(), planned: { amountMinor: '1', currency: '' } },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(
      (
        await f.admin.query(
          'select category_id::text, planned_minor::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ category_id: IDS.category, planned_minor: '77' }]);
  });

  it('28 rejects an empty planned amount without deleting stored allocations', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,77)',
      [IDS.workspace, budget.id, IDS.category],
    );
    const response = await put(budget.id, {
      allocations: [
        { ...allocation(), planned: { amountMinor: '', currency: 'USD' } },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(
      (
        await f.admin.query(
          'select planned_minor::text from public.budget_allocations where budget_id=$1',
          [budget.id],
        )
      ).rows,
    ).toEqual([{ planned_minor: '77' }]);
  });

  it.each([
    ['unsupported currency', 'XYZ'],
    ['non-string currency', 123],
    ['fractional amount', '1.5'],
    ['non-numeric amount', 'abc'],
  ])(
    '29 rejects %s without deleting stored allocations',
    async (_name, value) => {
      const budget = await create();
      await f.admin.query(
        'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,77)',
        [IDS.workspace, budget.id, IDS.category],
      );
      const planned =
        typeof value === 'number'
          ? { amountMinor: '1', currency: value }
          : value === '1.5' || value === 'abc'
            ? { amountMinor: value, currency: 'USD' }
            : { amountMinor: '1', currency: value };
      const response = await put(budget.id, {
        allocations: [{ ...allocation(), planned }],
      });
      expect(response.statusCode).toBe(422);
      expect(
        (
          await f.admin.query(
            'select planned_minor::text from public.budget_allocations where budget_id=$1',
            [budget.id],
          )
        ).rows,
      ).toEqual([{ planned_minor: '77' }]);
    },
  );

  it('30 emits all allocations in a valid multi-allocation request', async () => {
    const budget = await create();
    const response = await put(budget.id, {
      allocations: [
        allocation(IDS.category, '1000'),
        allocation(IDS.statusCategory, '2000'),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().allocations).toHaveLength(2);
    expect(
      (
        await f.admin.query(
          'select category_id::text, planned_minor::text from public.budget_allocations where budget_id=$1 order by category_id',
          [budget.id],
        )
      ).rows,
    ).toEqual([
      { category_id: IDS.category, planned_minor: '1000' },
      { category_id: IDS.statusCategory, planned_minor: '2000' },
    ]);
  });
});

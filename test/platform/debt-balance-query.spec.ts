import { describe, expect, it } from 'vitest';
import {
  buildDebtOutstandingBalanceSql,
  DEBT_OUTSTANDING_BALANCE_EXPRESSION,
} from '../../src/platform/debt-balance-query.js';

describe('debt-balance-query', () => {
  it('builds debt outstanding balance SQL with default alias "d"', () => {
    const sql = buildDebtOutstandingBalanceSql();
    expect(sql).toBe(DEBT_OUTSTANDING_BALANCE_EXPRESSION);
    expect(sql).toContain('d.principal_minor');
    expect(sql).toContain('dp.workspace_id = d.workspace_id');
    expect(sql).toContain('dp.debt_id = d.id');
    expect(sql).toContain('p.currency = d.currency');
    expect(sql).toContain("p.status in ('confirmed', 'reconciled')");
    expect(sql).toContain('p.account_id is not null');
    expect(sql).toContain('greatest(');
  });

  it('builds debt outstanding balance SQL with custom alias', () => {
    const sql = buildDebtOutstandingBalanceSql('debt');
    expect(sql).toContain('debt.principal_minor');
    expect(sql).toContain('dp.workspace_id = debt.workspace_id');
    expect(sql).toContain('dp.debt_id = debt.id');
    expect(sql).toContain('p.currency = debt.currency');
  });
});

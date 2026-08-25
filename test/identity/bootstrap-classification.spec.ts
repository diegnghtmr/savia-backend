import { describe, expect, it } from 'vitest';

import type { BootstrapCommand } from '../../src/identity/bootstrap-command.js';
import { BootstrapService } from '../../src/identity/bootstrap.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  BOOTSTRAP_CLASSIFICATIONS,
  classifyBootstrap,
  type BootstrapEvidence,
} from '../../src/identity/bootstrap-classification.js';

const command: BootstrapCommand = {
  subject: '00000000-0000-0000-0000-000000000301',
  email: 'ada@example.test',
  displayName: 'Ada',
  locale: 'en',
  countryCode: 'US',
  timezone: 'UTC',
  dateFormat: 'YYYY-MM-DD',
  weekStartsOn: 1,
  numberFormat: '1,234.56',
  defaultCurrency: 'USD',
  privacyModeEnabled: false,
  workspaceName: 'Ada Personal',
  baseCurrency: 'USD',
};
const profile = {
  id: command.subject,
  email: command.email,
  displayName: command.displayName,
  locale: command.locale,
  countryCode: command.countryCode,
  timezone: command.timezone,
  dateFormat: command.dateFormat,
  weekStartsOn: command.weekStartsOn,
  numberFormat: command.numberFormat,
  defaultCurrency: command.defaultCurrency,
  privacyModeEnabled: command.privacyModeEnabled,
};
const workspace = {
  id: '00000000-0000-0000-0000-000000000401',
  name: command.workspaceName,
  kind: 'personal',
  baseCurrency: command.baseCurrency,
  personalOwnerProfileId: command.subject,
};
const membership = {
  workspaceId: workspace.id,
  profileId: command.subject,
  role: 'owner',
  status: 'active',
};
const complete: BootstrapEvidence = {
  profiles: [profile],
  workspaces: [workspace],
  memberships: [membership],
};

describe('classifyBootstrap', () => {
  it('classifies zero, exact replay, and every canonical difference', () => {
    expect(
      classifyBootstrap(command, {
        profiles: [],
        workspaces: [],
        memberships: [],
      }),
    ).toBe(BOOTSTRAP_CLASSIFICATIONS.CREATE);
    expect(classifyBootstrap(command, complete)).toBe(
      BOOTSTRAP_CLASSIFICATIONS.REPLAY,
    );
    for (const [field, value] of Object.entries({
      email: 'other@example.test',
      displayName: 'Other',
      locale: 'es',
      countryCode: 'CO',
      timezone: 'America/Bogota',
      dateFormat: 'DD/MM/YYYY',
      weekStartsOn: 0,
      numberFormat: '1.234,56',
      defaultCurrency: 'COP',
      privacyModeEnabled: true,
      workspaceName: 'Other',
      baseCurrency: 'COP',
    }))
      expect(classifyBootstrap({ ...command, [field]: value }, complete)).toBe(
        BOOTSTRAP_CLASSIFICATIONS.CONFLICT,
      );
  });

  it('rejects partial shapes and mislinked complete evidence', () => {
    for (let mask = 1; mask < 7; mask += 1)
      expect(
        classifyBootstrap(command, {
          profiles: mask & 1 ? [profile] : [],
          workspaces: mask & 2 ? [workspace] : [],
          memberships: mask & 4 ? [membership] : [],
        }),
      ).toBe(BOOTSTRAP_CLASSIFICATIONS.INCOMPLETE);
    for (const evidence of [
      { ...complete, profiles: [{ ...profile, id: 'different' }] },
      { ...complete, workspaces: [{ ...workspace, kind: 'shared' }] },
      {
        ...complete,
        workspaces: [{ ...workspace, personalOwnerProfileId: 'different' }],
      },
      {
        ...complete,
        memberships: [{ ...membership, workspaceId: 'different' }],
      },
      { ...complete, memberships: [{ ...membership, profileId: 'different' }] },
      { ...complete, memberships: [{ ...membership, role: 'editor' }] },
      { ...complete, memberships: [{ ...membership, status: 'suspended' }] },
    ])
      expect(classifyBootstrap(command, evidence)).toBe(
        BOOTSTRAP_CLASSIFICATIONS.INCOMPLETE,
      );
  });
});

describe('BootstrapService', () => {
  it('enters the transaction before reading and replays without creating', async () => {
    const calls: string[] = [];
    const service = new BootstrapService(
      {
        run: async (_subject, callback) => {
          calls.push('transaction');
          return callback({} as TransactionClient);
        },
      },
      {
        read: async () => {
          calls.push('read');
          return complete;
        },
        create: async () => {
          throw new Error('must not create');
        },
      },
    );
    await expect(service.execute(command)).resolves.toEqual({
      kind: 'replayed',
      aggregate: { profileId: profile.id, workspaceId: workspace.id },
    });
    expect(calls).toEqual(['transaction', 'read']);
  });
});

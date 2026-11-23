import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

/**
 * Mention du rappel de bump (`/rappel-bump`).
 *
 * Le rappel mentionne le dernier bumper, sauf s'il a demandé à ne plus l'être.
 * Son nom reste affiché dans tous les cas : seule la notification saute. Une
 * base illisible ne doit jamais se traduire par une mention malgré un refus.
 */

type ProfileRow = { bumpPingOptOut: boolean } | null;

let profileRow: ProfileRow = null;
let findUniqueFails = false;

const findUnique = mock((_args?: unknown) => {
  if (findUniqueFails) return Promise.reject(new Error('base indisponible'));
  return Promise.resolve(profileRow);
});
const profileUpsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));

const GUILD = 'guild-bump';
const BUMPER = 'user-bumper';

const dueState = {
  guildId: GUILD,
  provider: 'disboard',
  providerLabel: 'Disboard',
  lastBumpAt: new Date(Date.now() - 3 * 60 * 60_000),
  lastBumpUserId: BUMPER as string | null,
  lastChannelId: 'channel-bump',
  nextBumpAt: new Date(Date.now() - 60 * 60_000),
  reminded: false,
};

const bumpFindMany = mock((_args?: unknown) => Promise.resolve([{ ...dueState }]));
const bumpUpdate = mock((_args?: unknown) => Promise.resolve({}));

const mockDb = {
  memberProfile: { findUnique, upsert: profileUpsert },
  bumpState: { findMany: bumpFindMany, update: bumpUpdate },
  guild: { upsert: mock((_args?: unknown) => Promise.resolve({ id: GUILD })) },
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const {
  hasOptedOutOfBumpPing,
  setBumpPingOptOut,
  processDueBumpReminders,
} = await import('../../services/integrations/bumpDetectionService.js');

const {
  buildBumpReminderPanel,
  BUMP_MENTION_OFF_ID,
  BUMP_MENTION_ON_ID,
} = await import('../../commands/utility/bumpReminder.js');

const send = mock((_payload?: unknown) => Promise.resolve({}));
const client = {
  channels: {
    fetch: mock(() => Promise.resolve({ isTextBased: () => true, send })),
  },
} as unknown as Client;

type SentPayload = { allowedMentions: { users: string[] }; components: Array<{ toJSON(): unknown }> };

function lastSent(): SentPayload {
  const calls = send.mock.calls;
  return calls[calls.length - 1]![0] as SentPayload;
}

function sentText(payload: SentPayload): string {
  return JSON.stringify(payload.components.map((c) => c.toJSON()));
}

beforeEach(() => {
  profileRow = null;
  findUniqueFails = false;
  dueState.lastBumpUserId = BUMPER;
  findUnique.mockClear();
  profileUpsert.mockClear();
  bumpFindMany.mockClear();
  bumpUpdate.mockClear();
  send.mockClear();
});

describe('hasOptedOutOfBumpPing', () => {
  test('mentionne par défaut sans profil enregistré', async () => {
    expect(await hasOptedOutOfBumpPing(GUILD, 'user-1')).toBe(false);
  });

  test('respecte un refus enregistré', async () => {
    profileRow = { bumpPingOptOut: true };
    expect(await hasOptedOutOfBumpPing(GUILD, 'user-2')).toBe(true);
  });

  test('ne mentionne pas quand la lecture échoue', async () => {
    findUniqueFails = true;
    expect(await hasOptedOutOfBumpPing(GUILD, 'user-3')).toBe(true);
  });
});

describe('setBumpPingOptOut', () => {
  test('crée le profil manquant avec le choix du membre', async () => {
    await setBumpPingOptOut(GUILD, 'user-4', true, { username: 'membre' });

    const args = profileUpsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(args.update).toEqual({ bumpPingOptOut: true });
    expect(args.create).toMatchObject({ guildId: GUILD, userId: 'user-4', username: 'membre', bumpPingOptOut: true });
  });
});

describe('processDueBumpReminders', () => {
  test('mentionne le dernier bumper et indique comment couper la mention', async () => {
    await processDueBumpReminders(client);

    const payload = lastSent();
    expect(payload.allowedMentions.users).toEqual([BUMPER]);
    expect(sentText(payload)).toContain('/rappel-bump');
  });

  test("garde le nom mais coupe la notification d'un bumper qui a refusé", async () => {
    profileRow = { bumpPingOptOut: true };
    await processDueBumpReminders(client);

    const payload = lastSent();
    expect(payload.allowedMentions.users).toEqual([]);
    expect(sentText(payload)).toContain(`<@${BUMPER}>`);
    expect(sentText(payload)).not.toContain('/rappel-bump');
  });

  test('ne mentionne personne quand la lecture du refus échoue', async () => {
    findUniqueFails = true;
    await processDueBumpReminders(client);

    expect(lastSent().allowedMentions.users).toEqual([]);
  });

  test('marque le rappel comme envoyé', async () => {
    await processDueBumpReminders(client);

    expect(bumpUpdate).toHaveBeenCalledTimes(1);
    expect((bumpUpdate.mock.calls[0]![0] as { data: unknown }).data).toEqual({ reminded: true });
  });
});

describe('buildBumpReminderPanel', () => {
  const status = {
    provider: 'disboard',
    providerLabel: 'Disboard',
    lastBumpAt: new Date(Date.now() - 80 * 60_000),
    lastBumpUserId: BUMPER,
    nextBumpAt: new Date(Date.now() + 40 * 60_000),
    overdue: false,
    overdueMinutes: 0,
    reminderChannelId: 'channel-bump',
  };

  function panelText(panel: { toJSON(): unknown }): string {
    return JSON.stringify(panel.toJSON());
  }

  test('propose de couper la mention quand elle est active', () => {
    const text = panelText(buildBumpReminderPanel({ status, optedOut: false, locale: 'fr' }));
    expect(text).toContain(BUMP_MENTION_OFF_ID);
    expect(text).not.toContain(BUMP_MENTION_ON_ID);
    expect(text).toContain('Prochain bump possible sur **Disboard**');
    expect(text).toContain(`<@${BUMPER}>`);
  });

  test('propose de réactiver la mention quand elle est coupée', () => {
    const text = panelText(buildBumpReminderPanel({ status, optedOut: true, locale: 'fr' }));
    expect(text).toContain(BUMP_MENTION_ON_ID);
    expect(text).not.toContain(BUMP_MENTION_OFF_ID);
    expect(text).toContain('Coupée');
  });

  test('annonce une fenêtre déjà ouverte', () => {
    const text = panelText(buildBumpReminderPanel({
      status: { ...status, nextBumpAt: new Date(Date.now() - 5 * 60_000), overdue: true, overdueMinutes: 5 },
      optedOut: false,
      locale: 'fr',
    }));
    expect(text).toContain('peut être bump sur **Disboard** depuis');
  });

  test("explique la détection automatique quand aucun bump n'a été vu", () => {
    const text = panelText(buildBumpReminderPanel({ status: null, optedOut: false, locale: 'fr' }));
    expect(text).toContain('Aucun bump repéré');
    expect(text).toContain(BUMP_MENTION_OFF_ID);
  });
});

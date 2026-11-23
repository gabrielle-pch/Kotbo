/**
 * `/rappel-bump` (`/bump-reminder`) - où en est le bump du serveur, et la
 * mention du rappel pour soi.
 *
 * Le panneau est éphémère : il montre le prochain bump possible, le dernier
 * bump, et l'état de la mention du membre, avec un bouton pour la couper ou la
 * réactiver. Couper la mention ne retire pas le nom du rappel : seule la
 * notification saute.
 *
 * Volontairement pas `/bump` : c'est la commande des bots de bump (Disboard...)
 * que les membres tapent pour bump, deux `/bump` dans la liste prêteraient à
 * confusion.
 */

import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ContainerBuilder,
} from 'discord.js';
import { richContainer } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata, type BotLocale } from '../../utils/i18n.js';
import {
  getBumpStatus,
  hasOptedOutOfBumpPing,
  setBumpPingOptOut,
  type BumpStatus,
} from '../../services/integrations/bumpDetectionService.js';
import { memberProfileIdentity } from '../../services/moderation/memberIdentityService.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('bumprem');

/** Boutons du panneau : l'état visé est dans l'identifiant, un double clic ne rebascule pas. */
export const BUMP_MENTION_OFF_ID = 'bumpreminder:mention:off';
export const BUMP_MENTION_ON_ID = 'bumpreminder:mention:on';

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

/** `<t:…:R>` : « dans 42 minutes », « il y a 1 heure », dans la langue de chacun. */
function relative(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function statusText(status: BumpStatus | null, locale: BotLocale): string {
  if (!status) return m.bumprem_no_bump({}, { locale });

  const provider = status.providerLabel;
  const when = relative(status.nextBumpAt);
  const next = status.overdue
    ? m.bumprem_next_open({ provider, when }, { locale })
    : m.bumprem_next_wait({ provider, when }, { locale });

  const lastWhen = relative(status.lastBumpAt);
  const last = status.lastBumpUserId
    ? m.bumprem_last({ user: `<@${status.lastBumpUserId}>`, when: lastWhen }, { locale })
    : m.bumprem_last_unknown({ when: lastWhen }, { locale });

  return `${next}\n${last}`;
}

/** Panneau affiché par la commande, et redessiné après un clic sur le bouton. */
export function buildBumpReminderPanel(params: {
  status: BumpStatus | null;
  optedOut: boolean;
  locale: BotLocale;
}): ContainerBuilder {
  const { status, optedOut, locale } = params;

  const button = optedOut
    ? new ButtonBuilder()
      .setCustomId(BUMP_MENTION_ON_ID)
      .setLabel(m.bumprem_button_on({}, { locale }))
      .setStyle(ButtonStyle.Primary)
    : new ButtonBuilder()
      .setCustomId(BUMP_MENTION_OFF_ID)
      .setLabel(m.bumprem_button_off({}, { locale }))
      .setStyle(ButtonStyle.Secondary);

  return richContainer({
    title: `📈 ${m.bumprem_title({}, { locale })}`,
    description: statusText(status, locale),
    fields: [
      {
        name: m.bumprem_mention_title({}, { locale }),
        value: optedOut
          ? m.bumprem_mention_off({}, { locale })
          : m.bumprem_mention_on({}, { locale }),
      },
    ],
    actionRow: new ActionRowBuilder<ButtonBuilder>().addComponents(button),
  });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Commande de guilde (module `bump_reminder`) : jamais proposée en MP.
  const guildId = interaction.guildId;
  if (!guildId) return;

  const locale = await getEffectiveLocale(interaction);
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const [status, optedOut] = await Promise.all([
    getBumpStatus(guildId),
    hasOptedOutOfBumpPing(guildId, interaction.user.id),
  ]);

  await interaction.editReply({
    components: [buildBumpReminderPanel({ status, optedOut, locale })],
    flags: [MessageFlags.IsComponentsV2],
    allowedMentions: { parse: [] },
  });
}

/** Clic sur « Ne plus me mentionner » / « Me mentionner à nouveau ». */
export async function handleBumpReminderMentionButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const optedOut = interaction.customId === BUMP_MENTION_OFF_ID;
  const locale = await getEffectiveLocale(interaction);
  await interaction.deferUpdate();

  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  await setBumpPingOptOut(
    guildId,
    interaction.user.id,
    optedOut,
    member ? memberProfileIdentity(member) : undefined,
  );

  const status = await getBumpStatus(guildId);
  await interaction.editReply({
    components: [buildBumpReminderPanel({ status, optedOut, locale })],
    allowedMentions: { parse: [] },
  });
}

export const bumpReminderCommand = { data, execute } satisfies SlashCommandDefinition;

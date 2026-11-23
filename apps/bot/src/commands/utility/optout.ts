/**
 * `/opt-out` - choix individuels d'un membre sur ce serveur.
 *
 *  - `presence` : retrait du suivi de présence. Pendant Discord des réglages
 *    de confidentialité du dashboard : les deux écrivent le même champ sur le
 *    `MemberProfile`, et sont donc réversibles depuis l'un comme depuis l'autre.
 *  - `bump` : le rappel de bump ne mentionne plus le membre après ses bumps
 *    (son nom reste affiché, seule la notification saute).
 *
 * Les réponses sont éphémères - un choix personnel n'a pas à s'afficher dans
 * le salon.
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
  type GuildMember,
} from 'discord.js';
import { successEmbed, errorEmbed, infoEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata, type BotLocale } from '../../utils/i18n.js';
import { logger } from '../../utils/logger.js';
import {
  getPresencePrivacyState,
  setPresenceTrackingOptOut,
} from '../../services/core/presencePrivacyService.js';
import {
  hasOptedOutOfBumpPing,
  setBumpPingOptOut,
} from '../../services/integrations/bumpDetectionService.js';
import { memberProfileIdentity } from '../../services/moderation/memberIdentityService.js';
import { syncMemberAutoRoles } from '../../services/features/serverTagRoleService.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('optout');
const presenceMeta = getCommandMetadata('optout_presence');
const bumpMeta = getCommandMetadata('optout_bump');

/** Boutons de retour en arrière posés sous la confirmation de retrait. */
export const OPT_OUT_PRESENCE_RESUME_ID = 'optout:presence:resume';
export const OPT_OUT_BUMP_RESUME_ID = 'optout:bump:resume';

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub
      .setName(presenceMeta.name)
      .setNameLocalizations(presenceMeta.nameLocalizations)
      .setDescription(presenceMeta.description)
      .setDescriptionLocalizations(presenceMeta.descriptionLocalizations),
  )
  .addSubcommand((sub) =>
    sub
      .setName(bumpMeta.name)
      .setNameLocalizations(bumpMeta.nameLocalizations)
      .setDescription(bumpMeta.description)
      .setDescriptionLocalizations(bumpMeta.descriptionLocalizations),
  );

function resumeRow(customId: string, label: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary),
  );
}

function presenceResumeRow(locale: BotLocale): ActionRowBuilder<ButtonBuilder> {
  return resumeRow(OPT_OUT_PRESENCE_RESUME_ID, m.optout_presence_resume_button({}, { locale }));
}

function bumpResumeRow(locale: BotLocale): ActionRowBuilder<ButtonBuilder> {
  return resumeRow(OPT_OUT_BUMP_RESUME_ID, m.optout_bump_resume_button({}, { locale }));
}

async function replyGuildOnly(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  await interaction.reply({
    embeds: [
      errorEmbed(
        m.optout_guild_only_title({}, { locale }),
        m.optout_guild_only_desc({}, { locale }),
      ),
    ],
    flags: [MessageFlags.Ephemeral],
  });
}

/** `<t:…:D>` : chaque membre lit la date dans son propre fuseau. */
function discordDate(date: Date | null): string {
  if (!date) return '-';
  return `<t:${Math.floor(date.getTime() / 1000)}:D>`;
}

async function resolveMember(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<GuildMember | null> {
  return interaction.guild?.members.fetch(interaction.user.id).catch(() => null) ?? null;
}

/**
 * Retire les rôles hérités de la présence après un changement de choix.
 *
 * Le scan de statut ne lit plus le membre retiré : sans resynchronisation, le
 * rôle déjà attribué resterait en place jusqu'à un futur événement.
 */
async function resyncAutoRoles(member: GuildMember | null): Promise<void> {
  if (!member) return;
  try {
    await syncMemberAutoRoles(member);
  } catch (err) {
    logger.error('OptOut', `Resynchronisation des auto-rôles impossible pour ${member.id}`, err);
  }
}

async function handlePresence(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const current = await getPresencePrivacyState(guildId, interaction.user.id);
  if (current.optedOut) {
    await interaction.editReply({
      embeds: [
        infoEmbed(
          m.optout_presence_already_title({}, { locale }),
          m.optout_presence_already_desc({ since: discordDate(current.since) }, { locale }),
        ),
      ],
      components: [presenceResumeRow(locale)],
    });
    return;
  }

  const member = await resolveMember(interaction);
  const state = await setPresenceTrackingOptOut(
    guildId,
    interaction.user.id,
    true,
    member ? memberProfileIdentity(member) : undefined,
  );
  await resyncAutoRoles(member);

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.optout_presence_done_title({}, { locale }),
        m.optout_presence_done_desc({ since: discordDate(state.since) }, { locale }),
      ),
    ],
    components: [presenceResumeRow(locale)],
  });
}

/** Clic sur « reprendre le suivi » : le message étant éphémère, seul l'auteur y accède. */
export async function handleOptOutPresenceResume(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await replyGuildOnly(interaction);
    return;
  }

  const locale = await getEffectiveLocale(interaction);
  await interaction.deferUpdate();

  const member = await resolveMember(interaction);
  await setPresenceTrackingOptOut(
    interaction.guildId,
    interaction.user.id,
    false,
    member ? memberProfileIdentity(member) : undefined,
  );
  await resyncAutoRoles(member);

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.optout_presence_resumed_title({}, { locale }),
        m.optout_presence_resumed_desc({}, { locale }),
      ),
    ],
    components: [],
  });
}

async function handleBump(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  if (await hasOptedOutOfBumpPing(guildId, interaction.user.id)) {
    await interaction.editReply({
      embeds: [
        infoEmbed(
          m.optout_bump_already_title({}, { locale }),
          m.optout_bump_already_desc({}, { locale }),
        ),
      ],
      components: [bumpResumeRow(locale)],
    });
    return;
  }

  const member = await resolveMember(interaction);
  await setBumpPingOptOut(
    guildId,
    interaction.user.id,
    true,
    member ? memberProfileIdentity(member) : undefined,
  );

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.optout_bump_done_title({}, { locale }),
        m.optout_bump_done_desc({}, { locale }),
      ),
    ],
    components: [bumpResumeRow(locale)],
  });
}

/** Clic sur « réactiver la mention » : le message étant éphémère, seul l'auteur y accède. */
export async function handleOptOutBumpResume(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await replyGuildOnly(interaction);
    return;
  }

  const locale = await getEffectiveLocale(interaction);
  await interaction.deferUpdate();

  const member = await resolveMember(interaction);
  await setBumpPingOptOut(
    interaction.guildId,
    interaction.user.id,
    false,
    member ? memberProfileIdentity(member) : undefined,
  );

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.optout_bump_resumed_title({}, { locale }),
        m.optout_bump_resumed_desc({}, { locale }),
      ),
    ],
    components: [],
  });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyGuildOnly(interaction);
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === presenceMeta.name) {
    await handlePresence(interaction, guildId);
  } else if (sub === bumpMeta.name) {
    await handleBump(interaction, guildId);
  }
}

export const optOutCommand = { data, execute } satisfies SlashCommandDefinition;

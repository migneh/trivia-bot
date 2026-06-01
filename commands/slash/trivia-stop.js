'use strict';
/**
 * commands/slash/trivia-stop.js
 *
 * Stops the active trivia session in the guild.
 *
 * ─── Behaviour by game phase ──────────────────────────────────────────────────
 *
 *   VOTING phase (players can still answer):
 *     → Show Arabic confirmation prompt with Confirm + Cancel buttons.
 *     → Confirmation expires after stopConfirmationTimeoutMs (30s default).
 *     → If confirmed: call endSession(reason='stopped') immediately.
 *     → If cancelled or timed out: leave session running, update message.
 *
 *   REVEALING phase (between answer reveal and auto-advance):
 *     → Set stopRequested = true, stopPhase = 'revealing'.
 *     → The reveal completes naturally (players see the answer).
 *     → gameEngine detects the flag after the 3s delay and ends the session.
 *     → Reply: "سيتم الإيقاف بعد انتهاء الكشف الحالي."
 *
 * ─── Results on stop ─────────────────────────────────────────────────────────
 *
 *   endSession() with reason='stopped' posts a results embed with scores
 *   earned so far. NO completion bonus is awarded to anyone.
 *
 * ─── Permission ──────────────────────────────────────────────────────────────
 *
 *   Requires wizard-configured manager roles OR Administrator.
 *   Same permission check as trivia-start.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const config  = require('../../config.json');
const sm      = require('../../utils/sessionManager');
const { endSession } = require('../../utils/gameEngine');
const queries = require('../../database/queries');

// ─── Timeout for the stop confirmation prompt ──────────────────────────────────
const CONFIRM_TIMEOUT_MS = config.stopConfirmationTimeoutMs ?? 30_000;


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-stop')
    .setDescription('أوقف الجلسة النشطة وعرض النتائج الجزئية')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;

    // ── Permission check ───────────────────────────────────────────────────────
    const settings = queries.getGuildSettings(guildId);

    if (!canManageSession(interaction, settings)) {
      return interaction.editReply({
        content: '⛔ ليس لديك صلاحية لإيقاف الجلسة.\nتحتاج إلى أحد أدوار الإدارة المعيّنة أو صلاحية Administrator.',
      });
    }

    // ── Guard: must have active session ────────────────────────────────────────
    const session = sm.getSession(guildId);
    if (!session) {
      return interaction.editReply({
        content: '⚠️ لا توجد جلسة مسابقة نشطة حالياً في هذا السيرفر.',
      });
    }

    // ── Guard: session already ending ──────────────────────────────────────────
    if (session.isEnding) {
      return interaction.editReply({
        content: '⏳ الجلسة تنتهي بالفعل، يرجى الانتظار...',
      });
    }

    // ── Phase: REVEALING ───────────────────────────────────────────────────────
    // Game is currently showing the answer — stop after reveal completes.
    if (session.stopPhase === 'revealing') {
      sm.updateSession(guildId, { stopRequested: true });
      return interaction.editReply({
        content:
          '⏳ **طلب الإيقاف مُسجَّل.**\n' +
          'سيتم إنهاء الجلسة تلقائياً بعد انتهاء الكشف عن الإجابة الحالية.',
      });
    }

    // ── Phase: VOTING ──────────────────────────────────────────────────────────
    // Show confirmation prompt before stopping.
    await showStopConfirmation(interaction, guildId, session);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// STOP CONFIRMATION PROMPT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Show a confirmation embed with Confirm and Cancel buttons.
 * Waits for a response within CONFIRM_TIMEOUT_MS.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} guildId
 * @param {import('../../utils/sessionManager').SessionState} session
 */
async function showStopConfirmation(interaction, guildId, session) {
  const currentQ  = session.currentIndex + 1;
  const totalQ    = session.questionCount;
  const voteCount = Object.keys(session.currentVotes).length;
  const playerCount = session.scores.size;

  const confirmEmbed = new EmbedBuilder()
    .setTitle('⏹️ تأكيد إيقاف الجلسة')
    .setDescription(
      '**هل أنت متأكد من إيقاف الجلسة الحالية؟**\n\n' +
      `📋 **السؤال الحالي:** ${currentQ} من ${totalQ}\n` +
      `👥 **اللاعبون:** ${playerCount} لاعب\n` +
      `🗳️ **الأصوات الحالية:** ${voteCount}\n\n` +
      '⚠️ سيتم عرض النتائج الجزئية فقط — **لن تُمنح مكافأة الإكمال** لأي لاعب.'
    )
    .setColor(config.colors.warning)
    .setFooter({ text: `ينتهي التأكيد خلال ${Math.floor(CONFIRM_TIMEOUT_MS / 1000)} ثانية` });

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('stop_confirm')
      .setLabel('نعم، أوقف الجلسة')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('stop_cancel')
      .setLabel('لا، تراجع')
      .setStyle(ButtonStyle.Secondary),
  );

  const msg = await interaction.editReply({
    embeds:     [confirmEmbed],
    components: [confirmRow],
    fetchReply: true,
  });

  // ── Collect confirmation ────────────────────────────────────────────────────
  const collector = msg.createMessageComponentCollector({
    filter: i =>
      i.user.id === interaction.user.id &&
      (i.customId === 'stop_confirm' || i.customId === 'stop_cancel'),
    time: CONFIRM_TIMEOUT_MS,
    max:  1,
  });

  collector.on('collect', async i => {
    await i.deferUpdate();

    if (i.customId === 'stop_confirm') {
      await handleStopConfirmed(interaction, guildId);
    } else {
      await handleStopCancelled(interaction, guildId);
    }
  });

  collector.on('end', async (collected, reason) => {
    if (reason === 'time') {
      await handleStopTimeout(interaction, guildId);
    }
    // 'limit' reason = collected.size === max (already handled in 'collect')
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRMATION OUTCOMES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * User confirmed the stop.
 * End the session and update the reply.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} guildId
 */
async function handleStopConfirmed(interaction, guildId) {
  // Re-read session — it may have ended naturally while waiting for confirmation
  const currentSession = sm.getSession(guildId);

  if (!currentSession || currentSession.isEnding) {
    await interaction.editReply({
      content:    '⚠️ انتهت الجلسة قبل تأكيد الإيقاف.',
      embeds:     [],
      components: [],
    }).catch(() => {});
    return;
  }

  // Mark stop requested (in case revealAndAdvance is mid-flight)
  sm.updateSession(guildId, { stopRequested: true, stopPhase: 'voting' });

  // End the session immediately
  await endSession(interaction.client, currentSession, 'stopped');

  await interaction.editReply({
    content:    '✅ **تم إيقاف الجلسة.** تم عرض النتائج الجزئية في قناة الجلسة.',
    embeds:     [],
    components: [],
  }).catch(() => {});
}

/**
 * User cancelled the stop.
 * Update the reply and leave the session running.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} guildId
 */
async function handleStopCancelled(interaction, guildId) {
  const session = sm.getSession(guildId);
  const isStillActive = !!session && !session.isEnding;

  await interaction.editReply({
    content: isStillActive
      ? '↩️ **تم إلغاء الإيقاف** — الجلسة لا تزال نشطة.'
      : '⚠️ انتهت الجلسة بشكل طبيعي أثناء انتظار ردك.',
    embeds:     [],
    components: [],
  }).catch(() => {});
}

/**
 * Confirmation timed out.
 * Leave the session running and inform the user.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} guildId
 */
async function handleStopTimeout(interaction, guildId) {
  const session = sm.getSession(guildId);
  const isStillActive = !!session && !session.isEnding;

  await interaction.editReply({
    content: isStillActive
      ? '⏰ **انتهت مهلة التأكيد** — الجلسة لا تزال نشطة.\nاستخدم `/trivia-stop` مرة أخرى إذا أردت الإيقاف.'
      : '⏰ انتهت مهلة التأكيد، وكانت الجلسة قد انتهت بشكل طبيعي.',
    embeds:     [],
    components: [],
  }).catch(() => {});
}


// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the interaction user can manage trivia sessions.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object|null} settings
 * @returns {boolean}
 */
function canManageSession(interaction, settings) {
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (isAdmin) return true;

  let managerRoles = [];
  try { managerRoles = JSON.parse(settings?.manager_roles ?? '[]'); } catch {}

  if (managerRoles.length === 0) return false;
  return interaction.member.roles.cache.some(r => managerRoles.includes(r.id));
}

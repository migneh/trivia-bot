'use strict';
/**
 * commands/slash/trivia-skip.js
 *
 * Skips the current question immediately without revealing the answer.
 *
 * ─── Skip behaviour (per spec) ───────────────────────────────────────────────
 *
 *   ✓ Skipped questions are treated as if they never existed for scoring.
 *   ✓ No correct answer reveal — buttons turn grey (Secondary style).
 *   ✓ No score changes for anyone.
 *   ✓ No speed bonus awarded.
 *   ✓ Streaks are NOT reset — skips are streak-neutral for all players.
 *   ✓ The question index advances normally (skip q3 → go to q4).
 *   ✓ Skipped questions are excluded from the completion bonus calculation.
 *   ✓ Advances immediately — no 3-second auto-advance delay.
 *   ✓ consecutiveZeroVotes resets to 0 (skips don't count as idle).
 *   ✓ If skipping the last question → endSession(reason='completed').
 *
 * ─── Guards ───────────────────────────────────────────────────────────────────
 *
 *   - No active session → Arabic error.
 *   - Session already ending → Arabic error.
 *   - Session channel inaccessible → handleChannelLoss().
 *
 * ─── Permission ──────────────────────────────────────────────────────────────
 *
 *   Requires wizard-configured manager roles OR Administrator.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const config  = require('../../config.json');
const sm      = require('../../utils/sessionManager');
const { skipQuestion } = require('../../utils/gameEngine');
const queries = require('../../database/queries');


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-skip')
    .setDescription('تخطى السؤال الحالي فوراً (بدون كشف الإجابة)')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const client  = interaction.client;

    // ── Permission check ───────────────────────────────────────────────────────
    const settings = queries.getGuildSettings(guildId);

    if (!canManageSession(interaction, settings)) {
      return interaction.editReply({
        content:
          '⛔ ليس لديك صلاحية لتخطي السؤال.\n' +
          'تحتاج إلى أحد أدوار الإدارة المعيّنة أو صلاحية Administrator.',
      });
    }

    // ── Guard: must have active session ────────────────────────────────────────
    const session = sm.getSession(guildId);
    if (!session) {
      return interaction.editReply({
        content: '⚠️ لا توجد جلسة مسابقة نشطة حالياً.',
      });
    }

    // ── Guard: session already ending ──────────────────────────────────────────
    if (session.isEnding) {
      return interaction.editReply({
        content: '⏳ الجلسة تنتهي بالفعل، يرجى الانتظار...',
      });
    }

    // ── Confirm to the host (ephemeral) ───────────────────────────────────────
    const currentQ = session.currentIndex + 1;
    const totalQ   = session.questionCount;
    const question = session.questions[session.currentIndex];
    const catName  = config.categories.find(c => c.id === question?.category)?.nameAr ?? question?.category ?? '—';

    await interaction.editReply({
      content:
        `⏭️ **جاري تخطي السؤال ${currentQ} من ${totalQ}...**\n` +
        `📂 الفئة: ${catName}`,
    });

    // ── Fetch session channel ──────────────────────────────────────────────────
    let channel = null;
    try {
      channel = await client.channels.fetch(session.channelId);
      if (!channel?.isTextBased()) channel = null;
    } catch {
      channel = null;
    }

    // ── Execute skip ───────────────────────────────────────────────────────────
    // skipQuestion() handles:
    //   - disabling/greying current question buttons
    //   - marking the question index as skipped
    //   - resetting currentVotes and consecutiveZeroVotes
    //   - advancing to next question OR ending session if last question
    //   - channel loss fallback if channel is null
    await skipQuestion(client, session, channel);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the interaction user can manage trivia sessions.
 * Requires: wizard-configured manager roles OR Discord Administrator.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object|null} settings - guild settings row from DB
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

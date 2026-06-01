'use strict';
/**
 * commands/slash/trivia-schedule.js
 *
 * Step-4-only scheduling wizard.
 * Opens directly to the scheduling configuration without running the
 * full 6-step setup wizard.
 *
 * ─── Prerequisite check ──────────────────────────────────────────────────────
 *
 *   Before opening the wizard, checks whether a session channel has
 *   been configured for this guild via /trivia-setup.
 *
 *   If NOT configured:
 *     → Display Arabic warning and abort.
 *     → "لم يتم تحديد قناة الجلسة بعد — يرجى تشغيل /trivia-setup أولاً"
 *
 *   If configured:
 *     → Open the scheduling wizard pre-filled with existing settings.
 *
 * ─── Wizard flow ─────────────────────────────────────────────────────────────
 *
 *   Sub-step A — Mode selection:
 *     none    → disable scheduling immediately, done.
 *     daily   → proceed to sub-step B (time).
 *     weekly  → proceed to sub-step B (time) → sub-step C (weekdays).
 *
 *   Sub-step B — UTC time selection (HH:00).
 *
 *   Sub-step C — Weekday selection (weekly mode only, multi-select 1–7).
 *
 *   Sub-step D — Session parameters (question count, time limit per question).
 *
 *   Sub-step E — Review & confirm.
 *
 * ─── UTC note ─────────────────────────────────────────────────────────────────
 *
 *   "جميع الأوقات بتوقيت UTC — يرجى تحويل وقتك المحلي قبل الإعداد"
 *   Displayed prominently in every sub-step embed.
 *
 * ─── Pre-fill ─────────────────────────────────────────────────────────────────
 *
 *   Existing schedule settings are loaded from the schedule file and
 *   shown in the embed description so the admin knows what's currently active.
 *
 * ─── Save behaviour ──────────────────────────────────────────────────────────
 *
 *   Settings are saved on final confirmation only:
 *     - scheduler.applySchedule() registers/updates the cron job.
 *     - queries.upsertGuildSettings() persists schedule_mode + schedule_config.
 *
 * ─── Wizard timeout ──────────────────────────────────────────────────────────
 *
 *   wizardTimeoutMs (2 min by default) applies per sub-step.
 *   On timeout: edit the message to Arabic notice, disable all components.
 *
 * ─── Permission ──────────────────────────────────────────────────────────────
 *
 *   Requires Discord's built-in Administrator permission.
 *   Same as /trivia-setup — no manager role can run this command.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const config    = require('../../config.json');
const queries   = require('../../database/queries');
const scheduler = require('../../scheduler/manager');

// ─── Constants ────────────────────────────────────────────────────────────────
const WIZARD_TIMEOUT = config.wizardTimeoutMs ?? 120_000;

// ─── UTC note (shown in every sub-step) ───────────────────────────────────────
const UTC_NOTE =
  '> ⚠️ **جميع الأوقات بتوقيت UTC**\n' +
  '> يرجى تحويل وقتك المحلي قبل الإعداد.\n' +
  '> مثال: 10 مساءً بتوقيت الرياض (UTC+3) = **19:00 UTC**';

// ─── Day names in Arabic ───────────────────────────────────────────────────────
const DAY_NAMES = {
  0: 'الأحد',
  1: 'الاثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
};

// ─── Available question count presets ─────────────────────────────────────────
const QUESTION_COUNT_OPTIONS = [5, 10, 15, 20, 25, 30];

// ─── Available time limit presets (seconds) ────────────────────────────────────
const TIME_LIMIT_OPTIONS = [10, 15, 20, 30, 45, 60];

// ─── Embed colours ────────────────────────────────────────────────────────────
const STEP_COLOR    = config.colors.info;
const SUCCESS_COLOR = config.colors.success;
const WARN_COLOR    = config.colors.warning;
const ERROR_COLOR   = config.colors.error;


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-schedule')
    .setDescription('إعداد الجدولة التلقائية للجلسات (يتطلب صلاحية Administrator)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await runScheduleWizard(interaction);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN WIZARD RUNNER  (exported for prefix router)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the scheduling wizard.
 * Handles the prerequisite check, pre-fill, and all sub-steps.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 */
async function runScheduleWizard(interaction) {
  const guildId = interaction.guildId;

  // ── Prerequisite check ─────────────────────────────────────────────────────
  const settings = queries.getGuildSettings(guildId);

  if (!settings?.session_channel) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ الإعداد غير مكتمل')
          .setDescription(
            '**لم يتم تحديد قناة الجلسة بعد.**\n\n' +
            'يجب إعداد البوت أولاً قبل ضبط الجدولة.\n\n' +
            '📋 استخدم `/trivia-setup` لإتمام الإعداد الكامل، ثم عد لاستخدام هذا الأمر.'
          )
          .setColor(WARN_COLOR),
      ],
    });
    return;
  }

  // ── Load existing schedule (pre-fill) ─────────────────────────────────────
  const existing = scheduler.getSchedule(guildId) ?? {};

  // Draft — accumulates choices across sub-steps
  const draft = {
    mode:          existing.mode          ?? 'none',
    utcTime:       existing.utcTime       ?? null,
    weekdays:      existing.weekdays      ?? [],
    questionCount: existing.questionCount ?? 10,
    timeLimitSec:  existing.timeLimitSec  ?? 10,
    // Categories inherit from guild settings (not configurable here)
    categories:    existing.categories   ?? [],
  };

  // ── Run sub-steps in sequence ──────────────────────────────────────────────
  const modeResult = await runSubStepMode(interaction, draft, existing);
  if (!modeResult) return;

  // If mode is 'none', schedule was disabled — show confirmation and exit
  if (draft.mode === 'none') {
    await saveAndConfirm(interaction, guildId, draft, existing);
    return;
  }

  const timeResult = await runSubStepTime(interaction, draft);
  if (!timeResult) return;

  if (draft.mode === 'weekly') {
    const daysResult = await runSubStepDays(interaction, draft);
    if (!daysResult) return;
  }

  const paramsResult = await runSubStepParams(interaction, draft);
  if (!paramsResult) return;

  await runSubStepReview(interaction, guildId, draft, existing);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wait for a single component interaction matching one of the given customIds.
 * Returns the interaction, or null on timeout.
 *
 * @param {import('discord.js').Message} msg
 * @param {string} userId
 * @param {string[]} customIds
 * @returns {Promise<import('discord.js').MessageComponentInteraction | null>}
 */
function waitFor(msg, userId, customIds) {
  return new Promise(resolve => {
    const collector = msg.createMessageComponentCollector({
      filter: i => i.user.id === userId && customIds.includes(i.customId),
      time:   WIZARD_TIMEOUT,
      max:    1,
    });
    collector.on('collect', resolve);
    collector.on('end', (_, reason) => {
      if (reason === 'time') resolve(null);
    });
  });
}

/**
 * Show a timeout notice and disable all components.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 */
async function showTimeout(interaction) {
  await interaction.editReply({
    content:    '⏰ **انتهت صلاحية معالج الجدولة** — يرجى إعادة تشغيل الأمر `/trivia-schedule`.',
    embeds:     [],
    components: [],
  }).catch(() => {});
}

/**
 * Build a footer text showing existing schedule info.
 *
 * @param {object} existing - previously saved schedule object
 * @returns {string}
 */
function buildExistingNote(existing) {
  if (!existing.mode || existing.mode === 'none') {
    return 'الجدولة الحالية: غير مفعّلة';
  }
  if (existing.mode === 'daily') {
    return `الجدولة الحالية: يومي — ${existing.utcTime ?? '?'} UTC`;
  }
  if (existing.mode === 'weekly') {
    const days = (existing.weekdays ?? []).map(d => DAY_NAMES[d] ?? d).join('، ');
    return `الجدولة الحالية: أسبوعي — ${days} — ${existing.utcTime ?? '?'} UTC`;
  }
  return `الجدولة الحالية: ${existing.mode}`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUB-STEP A: MODE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sub-step A: Let the admin choose the scheduling mode.
 * Returns false on timeout.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {object} draft
 * @param {object} existing
 * @returns {Promise<boolean>}
 */
async function runSubStepMode(interaction, draft, existing) {
  const userId = interaction.user.id;

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId('sched_mode')
    .setPlaceholder('اختر وضع الجدولة...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('🔕 بدون جدولة')
        .setDescription('إلغاء الجدولة التلقائية — تبدأ الجلسات يدوياً فقط')
        .setValue('none')
        .setDefault(draft.mode === 'none'),

      new StringSelectMenuOptionBuilder()
        .setLabel('📅 يومي — وقت ثابت (UTC)')
        .setDescription('تبدأ جلسة واحدة كل يوم على نفس الساعة')
        .setValue('daily')
        .setDefault(draft.mode === 'daily'),

      new StringSelectMenuOptionBuilder()
        .setLabel('📆 أسبوعي — أيام محددة (UTC)')
        .setDescription('تبدأ الجلسة في أيام معينة من الأسبوع')
        .setValue('weekly')
        .setDefault(draft.mode === 'weekly'),
    );

  const embed = new EmbedBuilder()
    .setTitle('📅 إعداد الجدولة — وضع التشغيل')
    .setDescription(
      UTC_NOTE + '\n\n' +
      '**اختر كيف تريد جدولة الجلسات التلقائية:**\n\n' +
      '🔕 **بدون جدولة** — تُبدأ الجلسات يدوياً فقط عبر `/trivia-start`\n' +
      '📅 **يومي** — جلسة واحدة كل يوم على ساعة ثابتة\n' +
      '📆 **أسبوعي** — جلسة في أيام وأوقات محددة من الأسبوع'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: buildExistingNote(existing) });

  const msg = await interaction.editReply({
    embeds:     [embed],
    components: [new ActionRowBuilder().addComponents(modeSelect)],
    fetchReply: true,
  });

  const i = await waitFor(msg, userId, ['sched_mode']);
  if (!i) { await showTimeout(interaction); return false; }

  await i.deferUpdate();
  draft.mode = i.values[0];
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUB-STEP B: UTC TIME SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sub-step B: UTC hour selection.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {object} draft
 * @returns {Promise<boolean>}
 */
async function runSubStepTime(interaction, draft) {
  const userId = interaction.user.id;

  // Build 24 hourly options with Arabic time-of-day labels
  const timeOptions = Array.from({ length: 24 }, (_, h) => {
    const hStr   = String(h).padStart(2, '0');
    const label  = `${hStr}:00 UTC`;
    const period = h < 6  ? 'منتصف الليل / فجراً'
                 : h < 12 ? 'صباحاً'
                 : h < 17 ? 'ظهراً / عصراً'
                 : h < 21 ? 'مساءً'
                 :           'ليلاً';

    return new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setDescription(period)
      .setValue(`${hStr}:00`)
      .setDefault(draft.utcTime === `${hStr}:00`);
  });

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('sched_time')
    .setPlaceholder('اختر ساعة البداية (UTC)...')
    .addOptions(timeOptions);

  const modeLabel = draft.mode === 'daily' ? 'يومي' : 'أسبوعي';

  const embed = new EmbedBuilder()
    .setTitle('📅 إعداد الجدولة — وقت البداية')
    .setDescription(
      UTC_NOTE + '\n\n' +
      `**الوضع المختار:** ${draft.mode === 'daily' ? '📅 يومي' : '📆 أسبوعي'}\n\n` +
      `اختر الساعة التي تبدأ فيها الجلسة ${modeLabel === 'يومي' ? 'كل يوم' : 'في الأيام المحددة'}:\n\n` +
      '💡 **تحويل سريع للتوقيت العربي:**\n' +
      '• السعودية / الخليج (UTC+3): اطرح 3 من وقتك المحلي\n' +
      '• مصر (UTC+2): اطرح 2 من وقتك المحلي\n' +
      '• المغرب (UTC+1): اطرح 1 من وقتك المحلي'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'جميع الأوقات بتوقيت UTC الدولي' });

  const msg = await interaction.editReply({
    embeds:     [embed],
    components: [new ActionRowBuilder().addComponents(timeSelect)],
    fetchReply: true,
  });

  const i = await waitFor(msg, userId, ['sched_time']);
  if (!i) { await showTimeout(interaction); return false; }

  await i.deferUpdate();
  draft.utcTime = i.values[0];
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUB-STEP C: WEEKDAY SELECTION  (weekly mode only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sub-step C: Weekday multi-select (weekly mode only).
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {object} draft
 * @returns {Promise<boolean>}
 */
async function runSubStepDays(interaction, draft) {
  const userId = interaction.user.id;

  const dayOptions = Object.entries(DAY_NAMES).map(([value, label]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setDefault(draft.weekdays.includes(Number(value)))
  );

  const daySelect = new StringSelectMenuBuilder()
    .setCustomId('sched_days')
    .setPlaceholder('اختر الأيام (يمكن اختيار أكثر من يوم)...')
    .setMinValues(1)
    .setMaxValues(7)
    .addOptions(dayOptions);

  const embed = new EmbedBuilder()
    .setTitle('📅 إعداد الجدولة — أيام الأسبوع')
    .setDescription(
      UTC_NOTE + '\n\n' +
      `**الساعة المختارة:** ${draft.utcTime} UTC\n\n` +
      'اختر في أي أيام تبدأ الجلسة التلقائية:\n\n' +
      '💡 يمكنك اختيار يوم واحد أو عدة أيام في نفس الوقت.'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'اختر الأيام التي تريد تفعيل الجلسة فيها' });

  const msg = await interaction.editReply({
    embeds:     [embed],
    components: [new ActionRowBuilder().addComponents(daySelect)],
    fetchReply: true,
  });

  const i = await waitFor(msg, userId, ['sched_days']);
  if (!i) { await showTimeout(interaction); return false; }

  await i.deferUpdate();
  draft.weekdays = i.values.map(Number).sort((a, b) => a - b);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUB-STEP D: SESSION PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sub-step D: Select question count and time limit per question.
 * Both are shown as separate select menus on the same message.
 * Collects both via a sequential approach — count first, then time.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {object} draft
 * @returns {Promise<boolean>}
 */
async function runSubStepParams(interaction, draft) {
  const userId = interaction.user.id;

  const countSelect = new StringSelectMenuBuilder()
    .setCustomId('sched_count')
    .setPlaceholder('عدد الأسئلة في كل جلسة...')
    .addOptions(
      QUESTION_COUNT_OPTIONS.map(n =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${n} سؤالاً`)
          .setDescription(
            n <= 10 ? 'جلسة قصيرة (~' + (n * draft.timeLimitSec / 60).toFixed(0) + ' دقائق)'
            : n <= 20 ? 'جلسة متوسطة'
            : 'جلسة طويلة'
          )
          .setValue(String(n))
          .setDefault(draft.questionCount === n)
      )
    );

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('sched_timelimit')
    .setPlaceholder('وقت الإجابة على كل سؤال...')
    .addOptions(
      TIME_LIMIT_OPTIONS.map(n =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${n} ثانية لكل سؤال`)
          .setDescription(
            n <= 15 ? 'سريع جداً — للمنافسين'
            : n <= 25 ? 'متوسط — متوازن'
            : n <= 40 ? 'مريح — للجميع'
            : 'هادئ — وقت للتفكير'
          )
          .setValue(String(n))
          .setDefault(draft.timeLimitSec === n)
      )
    );

  const confirmBtn = new ButtonBuilder()
    .setCustomId('sched_params_confirm')
    .setLabel('تأكيد الإعدادات ←')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(false);

  const embed = new EmbedBuilder()
    .setTitle('📅 إعداد الجدولة — إعدادات الجلسة')
    .setDescription(
      '**اختر إعدادات الجلسات التلقائية:**\n\n' +
      '① **عدد الأسئلة** — كم سؤالاً في كل جلسة مجدولة؟\n' +
      '② **وقت الإجابة** — كم ثانية لكل سؤال؟\n\n' +
      '💡 هذه الإعدادات تُطبّق تلقائياً على كل جلسة مجدولة.\n' +
      'يمكن دائماً بدء جلسة يدوية بإعدادات مختلفة عبر `/trivia-start`.'
    )
    .setColor(STEP_COLOR)
    .addFields(
      {
        name:   '⚙️ الإعدادات الحالية',
        value:
          `• عدد الأسئلة: **${draft.questionCount}** سؤال\n` +
          `• وقت الإجابة: **${draft.timeLimitSec}** ثانية`,
        inline: false,
      }
    )
    .setFooter({ text: 'اختر القيم من القوائم أدناه ثم اضغط تأكيد' });

  const msg = await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(countSelect),
      new ActionRowBuilder().addComponents(timeSelect),
      new ActionRowBuilder().addComponents(confirmBtn),
    ],
    fetchReply: true,
  });

  // Collect menus and confirm button together
  return new Promise(resolve => {
    const collector = msg.createMessageComponentCollector({
      filter: i =>
        i.user.id === userId &&
        ['sched_count', 'sched_timelimit', 'sched_params_confirm'].includes(i.customId),
      time: WIZARD_TIMEOUT,
    });

    collector.on('collect', async i => {
      if (i.customId === 'sched_count') {
        draft.questionCount = parseInt(i.values[0], 10);
        await i.deferUpdate();

        // Update the current values field
        await interaction.editReply({
          embeds: [
            EmbedBuilder.from(embed).setFields({
              name:  '⚙️ الإعدادات الحالية',
              value:
                `• عدد الأسئلة: **${draft.questionCount}** سؤال ✅\n` +
                `• وقت الإجابة: **${draft.timeLimitSec}** ثانية`,
              inline: false,
            }),
          ],
        }).catch(() => {});
        return;
      }

      if (i.customId === 'sched_timelimit') {
        draft.timeLimitSec = parseInt(i.values[0], 10);
        await i.deferUpdate();

        await interaction.editReply({
          embeds: [
            EmbedBuilder.from(embed).setFields({
              name:  '⚙️ الإعدادات الحالية',
              value:
                `• عدد الأسئلة: **${draft.questionCount}** سؤال\n` +
                `• وقت الإجابة: **${draft.timeLimitSec}** ثانية ✅`,
              inline: false,
            }),
          ],
        }).catch(() => {});
        return;
      }

      if (i.customId === 'sched_params_confirm') {
        await i.deferUpdate();
        collector.stop('confirmed');
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        await showTimeout(interaction);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUB-STEP E: REVIEW & CONFIRM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sub-step E: Show a summary and ask for final confirmation.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {string} guildId
 * @param {object} draft
 * @param {object} existing
 */
async function runSubStepReview(interaction, guildId, draft, existing) {
  const userId = interaction.user.id;

  const saveBtn = new ButtonBuilder()
    .setCustomId('sched_save')
    .setLabel('✅ حفظ الجدولة')
    .setStyle(ButtonStyle.Success);

  const cancelBtn = new ButtonBuilder()
    .setCustomId('sched_cancel')
    .setLabel('❌ إلغاء بدون حفظ')
    .setStyle(ButtonStyle.Secondary);

  const reviewEmbed = buildReviewEmbed(draft, existing);

  const msg = await interaction.editReply({
    embeds:     [reviewEmbed],
    components: [new ActionRowBuilder().addComponents(saveBtn, cancelBtn)],
    fetchReply: true,
  });

  const i = await waitFor(msg, userId, ['sched_save', 'sched_cancel']);
  if (!i) { await showTimeout(interaction); return; }

  await i.deferUpdate();

  // ── Cancel ─────────────────────────────────────────────────────────────────
  if (i.customId === 'sched_cancel') {
    await interaction.editReply({
      content:    '❌ **تم إلغاء إعداد الجدولة** — لم يتم حفظ أي تغييرات.',
      embeds:     [],
      components: [],
    });
    return;
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  await saveAndConfirm(interaction, guildId, draft, existing);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAVE & CONFIRM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Persist the draft schedule and show a success or error message.
 * Also handles the 'none' mode (disabling scheduling).
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {string} guildId
 * @param {object} draft
 * @param {object} existing
 */
async function saveAndConfirm(interaction, guildId, draft, existing) {
  try {
    if (draft.mode === 'none') {
      // Disable scheduling
      scheduler.removeSchedule(guildId);
      queries.upsertGuildSettings(guildId, {
        schedule_mode:   'none',
        schedule_config: '{}',
      });

      const wasActive = existing.mode && existing.mode !== 'none';

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ تم إلغاء الجدولة التلقائية')
            .setDescription(
              wasActive
                ? `تم إيقاف الجدولة **${getModeLabel(existing.mode)}** السابقة.\n\nستبدأ الجلسات الآن يدوياً فقط عبر \`/trivia-start\`.`
                : 'لم تكن هناك جدولة نشطة. الجلسات تبدأ يدوياً فقط.'
            )
            .setColor(SUCCESS_COLOR),
        ],
        components: [],
      });
      return;
    }

    // Save active schedule
    const scheduleData = {
      mode:          draft.mode,
      utcTime:       draft.utcTime,
      weekdays:      draft.weekdays,
      questionCount: draft.questionCount,
      timeLimitSec:  draft.timeLimitSec,
      categories:    draft.categories,
    };

    scheduler.applySchedule(guildId, scheduleData);
    queries.upsertGuildSettings(guildId, {
      schedule_mode:   draft.mode,
      schedule_config: JSON.stringify(scheduleData),
    });

    // ── Success message ────────────────────────────────────────────────────
    const nextSessionNote = buildNextSessionNote(draft);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ تم حفظ إعدادات الجدولة!')
          .setDescription(
            '**الجدولة التلقائية مفعّلة الآن.**\n\n' +
            buildScheduleSummary(draft) + '\n\n' +
            nextSessionNote
          )
          .setColor(SUCCESS_COLOR)
          .addFields(
            {
              name:   '📋 تفاصيل الجلسات المجدولة',
              value:
                `• **عدد الأسئلة:** ${draft.questionCount} سؤال\n` +
                `• **وقت الإجابة:** ${draft.timeLimitSec} ثانية لكل سؤال\n` +
                `• **الفئات:** ${draft.categories.length > 0 ? draft.categories.join('، ') : 'كل الفئات'}`,
              inline: false,
            }
          )
          .setFooter({ text: 'جميع الأوقات UTC • يمكن تغيير الإعدادات في أي وقت' }),
      ],
      components: [],
    });

  } catch (err) {
    console.error('[Schedule] Failed to save schedule:', err.message);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⛔ فشل حفظ الجدولة')
          .setDescription(
            'حدث خطأ أثناء حفظ إعدادات الجدولة.\n' +
            `التفاصيل: \`${err.message}\`\n\n` +
            'يرجى المحاولة مجدداً.'
          )
          .setColor(ERROR_COLOR),
      ],
      components: [],
    }).catch(() => {});
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW EMBED BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the review embed for sub-step E.
 *
 * @param {object} draft
 * @param {object} existing
 * @returns {EmbedBuilder}
 */
function buildReviewEmbed(draft, existing) {
  const embed = new EmbedBuilder()
    .setTitle('📅 إعداد الجدولة — المراجعة')
    .setColor(WARN_COLOR)
    .setFooter({ text: 'راجع الإعدادات ثم اضغط حفظ أو إلغاء' });

  // Current (existing) schedule
  const existingNote = buildExistingNote(existing);

  // New schedule summary
  const newSummary = buildScheduleSummary(draft);

  embed.setDescription(
    '**راجع الإعدادات الجديدة قبل الحفظ:**\n\n' +
    `📌 **الإعداد الحالي:** ${existingNote}\n\n` +
    `✨ **الإعداد الجديد:**\n${newSummary}`
  );

  embed.addFields(
    {
      name:   '📋 معاملات الجلسات المجدولة',
      value:
        `• **عدد الأسئلة:** ${draft.questionCount} سؤال\n` +
        `• **وقت الإجابة:** ${draft.timeLimitSec} ثانية لكل سؤال`,
      inline: false,
    },
    {
      name:   '⚠️ ملاحظة',
      value:  'التغييرات تسري على الجلسات المجدولة القادمة فقط — لا تؤثر على الجلسة النشطة حالياً إن وجدت.',
      inline: false,
    }
  );

  return embed;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEXT FORMATTING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a human-readable schedule summary from a draft object.
 *
 * @param {object} draft
 * @returns {string}
 */
function buildScheduleSummary(draft) {
  if (draft.mode === 'none') {
    return '🔕 بدون جدولة — الجلسات تبدأ يدوياً فقط';
  }

  if (draft.mode === 'daily') {
    return (
      `📅 **يومي** — كل يوم الساعة **${draft.utcTime} UTC**`
    );
  }

  if (draft.mode === 'weekly') {
    const days = draft.weekdays
      .map(d => DAY_NAMES[d] ?? `يوم ${d}`)
      .join('، ');
    return (
      `📆 **أسبوعي** — كل **${days}**\n` +
      `الساعة **${draft.utcTime} UTC**`
    );
  }

  return draft.mode;
}

/**
 * Build a note explaining when the next scheduled session will fire.
 * Simplified — just describes the pattern.
 *
 * @param {object} draft
 * @returns {string}
 */
function buildNextSessionNote(draft) {
  if (draft.mode === 'daily') {
    return `⏰ الجلسة القادمة ستبدأ **اليوم أو غداً** الساعة **${draft.utcTime} UTC**.`;
  }
  if (draft.mode === 'weekly') {
    const days = draft.weekdays.map(d => DAY_NAMES[d] ?? d).join('، ');
    return `⏰ الجلسة القادمة ستبدأ في أقرب **${days}** الساعة **${draft.utcTime} UTC**.`;
  }
  return '';
}

/**
 * Get a human-readable mode label.
 *
 * @param {string} mode
 * @returns {string}
 */
function getModeLabel(mode) {
  const labels = { daily: 'اليومية', weekly: 'الأسبوعية', none: 'غير المجدولة' };
  return labels[mode] ?? mode;
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.runScheduleWizard = runScheduleWizard;

'use strict';
/**
 * commands/slash/trivia-start.js
 *
 * Starts a new trivia session via an interactive setup wizard.
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *
 *  1. Permission check (manager roles OR Administrator).
 *  2. Guard checks (session channel configured, no active session).
 *  3. Build setup wizard UI:
 *       Row 1 — Question count select (5 / 10 / 15 / 20 / 25 / 30)
 *       Row 2 — Time per question select (10 / 15 / 20 / 30 / 45 / 60 sec)
 *       Row 3 — Category multi-select (guild-enabled categories only)
 *       Row 4 — Start button (disabled until all 3 selections made) + Cancel
 *  4. Collect selections via inline MessageComponentCollector.
 *     Start button enables only when count + time + categories are all chosen.
 *  5. On confirm:
 *       a. Check question pool — warn if fewer available than requested.
 *       b. Validate images (parallel HEAD requests with cap).
 *       c. Create session in sessionManager.
 *       d. Fetch session channel and call startSession().
 *
 * ─── Pool exhaustion ─────────────────────────────────────────────────────────
 *
 *  If the available pool is smaller than the requested count, show a
 *  confirmation embed with "متابعة بالعدد المتاح" and "إلغاء" buttons.
 *  If pool is 0, abort immediately.
 *
 * ─── Wizard timeout ──────────────────────────────────────────────────────────
 *
 *  wizardTimeoutMs (config.json) — 2 minutes by default.
 *  On timeout: edit reply to Arabic timeout message, disable all components.
 *
 * ─── Race condition guard ────────────────────────────────────────────────────
 *
 *  Between wizard confirm and session creation, another user may have started
 *  a session. sm.createSession() returns false in that case — handled gracefully.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const config  = require('../../config.json');
const sm      = require('../../utils/sessionManager');
const qb      = require('../../utils/questionBank');
const { validateQuestionImages, applyImageValidation } = require('../../utils/imageValidator');
const { startSession } = require('../../utils/gameEngine');
const queries = require('../../database/queries');

// ─── Constants ────────────────────────────────────────────────────────────────
const QUESTION_COUNT_OPTIONS = [5, 10, 15, 20, 25, 30];
const TIME_LIMIT_OPTIONS     = [10, 15, 20, 30, 45, 60];
const POOL_CONFIRM_TIMEOUT   = 30_000; // 30 seconds


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-start')
    .setDescription('ابدأ جلسة مسابقة ثقافية عربية')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Always defer immediately — setup wizard takes time to build
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const client  = interaction.client;

    // ── Permission check ───────────────────────────────────────────────────────
    const settings = queries.getGuildSettings(guildId);

    if (!canManageSession(interaction, settings)) {
      return interaction.editReply({
        content: '⛔ ليس لديك صلاحية لبدء الجلسة.\nتحتاج إلى أحد أدوار الإدارة المعيّنة أو صلاحية Administrator.',
      });
    }

    // ── Guard: session channel must be configured ──────────────────────────────
    if (!settings?.session_channel) {
      return interaction.editReply({
        content:
          '⚠️ لم يتم إعداد قناة الجلسة بعد.\n' +
          'استخدم `/trivia-setup` أولاً لتهيئة البوت.',
      });
    }

    // ── Guard: no active session ───────────────────────────────────────────────
    if (sm.hasSession(guildId)) {
      return interaction.editReply({
        content: '⚠️ هناك جلسة مسابقة نشطة بالفعل في هذا السيرفر.\nاستخدم `/trivia-stop` لإنهائها أولاً.',
      });
    }

    // ── Resolve available categories ───────────────────────────────────────────
    const enabledCats   = parseJson(settings.enabled_categories, []);
    const availableCats = config.categories.filter(c =>
      enabledCats.length === 0 || enabledCats.includes(c.id)
    );

    if (availableCats.length === 0) {
      return interaction.editReply({
        content: '⚠️ لا توجد فئات مفعّلة في هذا السيرفر.\nراجع إعدادات البوت عبر `/trivia-setup`.',
      });
    }

    // ── Build wizard UI ────────────────────────────────────────────────────────
    const { embed, rows, menus, buttons } = buildWizardUI(availableCats);

    const msg = await interaction.editReply({
      embeds:     [embed],
      components: rows,
      fetchReply: true,
    });

    // ── Run the wizard ─────────────────────────────────────────────────────────
    await runSetupWizard({
      interaction,
      msg,
      guildId,
      client,
      settings,
      availableCats,
      embed,
      menus,
      buttons,
    });
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// WIZARD UI BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build all UI components for the session setup wizard.
 *
 * @param {{ id: string, nameAr: string }[]} availableCats
 * @returns {{ embed, rows, menus, buttons }}
 */
function buildWizardUI(availableCats) {
  const countMenu = new StringSelectMenuBuilder()
    .setCustomId('start_count')
    .setPlaceholder('① عدد الأسئلة')
    .addOptions(
      QUESTION_COUNT_OPTIONS.map(n =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${n} سؤالاً`)
          .setDescription(n <= 10 ? 'جلسة قصيرة' : n <= 20 ? 'جلسة متوسطة' : 'جلسة طويلة')
          .setValue(String(n))
      )
    );

  const timeMenu = new StringSelectMenuBuilder()
    .setCustomId('start_time')
    .setPlaceholder('② وقت كل سؤال (ثواني)')
    .addOptions(
      TIME_LIMIT_OPTIONS.map(n =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${n} ثانية`)
          .setDescription(n <= 15 ? 'سريع جداً' : n <= 25 ? 'متوسط' : 'مريح')
          .setValue(String(n))
      )
    );

  const catMenu = new StringSelectMenuBuilder()
    .setCustomId('start_cats')
    .setPlaceholder('③ الفئات (اختر واحدة أو أكثر)')
    .setMinValues(1)
    .setMaxValues(availableCats.length)
    .addOptions(
      availableCats.map(c =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.nameAr)
          .setValue(c.id)
      )
    );

  const startBtn = new ButtonBuilder()
    .setCustomId('start_confirm')
    .setLabel('ابدأ الجلسة 🚀')
    .setStyle(ButtonStyle.Success)
    .setDisabled(true);

  const cancelBtn = new ButtonBuilder()
    .setCustomId('start_cancel')
    .setLabel('إلغاء')
    .setStyle(ButtonStyle.Secondary);

  const embed = new EmbedBuilder()
    .setTitle('🎮 إعداد جلسة المسابقة')
    .setDescription(
      'اختر الإعدادات التالية ثم اضغط **ابدأ الجلسة**:\n\n' +
      '① **عدد الأسئلة** — كم سؤالاً تريد في هذه الجلسة؟\n' +
      '② **وقت كل سؤال** — كم ثانية لكل إجابة؟\n' +
      '③ **الفئات** — من أي مجالات تريد الأسئلة؟'
    )
    .setColor(config.colors.info)
    .setFooter({ text: `لديك ${Math.floor(config.wizardTimeoutMs / 60000)} دقائق لإتمام الإعداد` });

  const rows = [
    new ActionRowBuilder().addComponents(countMenu),
    new ActionRowBuilder().addComponents(timeMenu),
    new ActionRowBuilder().addComponents(catMenu),
    new ActionRowBuilder().addComponents(startBtn, cancelBtn),
  ];

  return {
    embed,
    rows,
    menus:   { countMenu, timeMenu, catMenu },
    buttons: { startBtn, cancelBtn },
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SETUP WIZARD LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the interactive setup wizard.
 * Collects selections and routes to launchSession() on confirm.
 */
async function runSetupWizard({ interaction, msg, guildId, client, settings, availableCats, embed, menus, buttons }) {
  const { countMenu, timeMenu, catMenu } = menus;
  const { startBtn, cancelBtn }          = buttons;

  // Track selections
  let selectedCount = null;
  let selectedTime  = null;
  let selectedCats  = null;

  const collector = msg.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time:   config.wizardTimeoutMs,
  });

  collector.on('collect', async i => {

    // ── Cancel button ──────────────────────────────────────────────────────────
    if (i.customId === 'start_cancel') {
      await i.update({
        content:    '❌ تم إلغاء إعداد الجلسة.',
        embeds:     [],
        components: [],
      });
      collector.stop('cancelled');
      return;
    }

    // ── Confirm button ─────────────────────────────────────────────────────────
    if (i.customId === 'start_confirm') {
      await i.deferUpdate();
      collector.stop('confirmed');
      return;
    }

    // ── Selection menus ────────────────────────────────────────────────────────
    await i.deferUpdate();

    if (i.customId === 'start_count') selectedCount = parseInt(i.values[0], 10);
    if (i.customId === 'start_time')  selectedTime  = parseInt(i.values[0], 10);
    if (i.customId === 'start_cats')  selectedCats  = i.values;

    // Update embed description and toggle start button
    const allSelected = selectedCount !== null && selectedTime !== null && selectedCats !== null;
    startBtn.setDisabled(!allSelected);

    const descLines = [
      `① **الأسئلة:** ${selectedCount !== null ? `**${selectedCount}** سؤالاً` : '—'}`,
      `② **الوقت:** ${selectedTime  !== null ? `**${selectedTime}** ثانية` : '—'}`,
      `③ **الفئات:** ${selectedCats  !== null ? `**${selectedCats.length}** فئة مختارة` : '—'}`,
      '',
      allSelected
        ? '✅ جاهز! اضغط **ابدأ الجلسة** للمتابعة.'
        : '⬆️ اختر جميع الخيارات أعلاه لتفعيل زر البدء.',
    ];

    await interaction.editReply({
      embeds: [
        EmbedBuilder.from(embed).setDescription(descLines.join('\n')),
      ],
      components: [
        new ActionRowBuilder().addComponents(countMenu),
        new ActionRowBuilder().addComponents(timeMenu),
        new ActionRowBuilder().addComponents(catMenu),
        new ActionRowBuilder().addComponents(startBtn, cancelBtn),
      ],
    }).catch(() => {});
  });

  collector.on('end', async (_, reason) => {

    // ── Timeout ────────────────────────────────────────────────────────────────
    if (reason === 'time') {
      await interaction.editReply({
        content:    '⏰ انتهت مهلة الإعداد. يرجى إعادة تشغيل الأمر.',
        embeds:     [],
        components: [],
      }).catch(() => {});
      return;
    }

    // ── Cancelled ──────────────────────────────────────────────────────────────
    if (reason !== 'confirmed') return;

    // ── Confirmed — validate and launch ───────────────────────────────────────
    await handleConfirmed({
      interaction,
      msg,
      guildId,
      client,
      settings,
      selectedCount,
      selectedTime,
      selectedCats,
    });
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle the wizard confirm action.
 * Checks pool size, shows confirmation if needed, then launches.
 */
async function handleConfirmed({ interaction, msg, guildId, client, settings, selectedCount, selectedTime, selectedCats }) {

  // Race condition guard — another user may have started a session
  if (sm.hasSession(guildId)) {
    await interaction.editReply({
      content:    '⚠️ بدأت جلسة أخرى في هذا السيرفر قبل تأكيدك.',
      embeds:     [],
      components: [],
    });
    return;
  }

  // Select questions from bank
  const pool = qb.selectQuestions(selectedCats, selectedCount);

  // ── Pool exhaustion warning ────────────────────────────────────────────────
  if (pool.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⛔ لا توجد أسئلة متاحة')
          .setDescription(
            'لا توجد أسئلة في الفئات المختارة.\n' +
            'جرّب اختيار فئات أخرى أو راجع قاعدة الأسئلة.'
          )
          .setColor(config.colors.error),
      ],
      components: [],
    });
    return;
  }

  if (pool.length < selectedCount) {
    // Fewer questions available than requested — ask for confirmation
    const confirmed = await askPoolConfirmation(interaction, msg, pool.length, selectedCount);
    if (!confirmed) return; // user cancelled or timed out
  }

  // Launch with however many we have (up to selectedCount)
  await launchSession({
    interaction,
    guildId,
    client,
    settings,
    questions:    pool.slice(0, selectedCount),
    timeLimitSec: selectedTime,
    categories:   selectedCats,
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// POOL EXHAUSTION CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Show a confirmation prompt when fewer questions are available than requested.
 * Returns true if the user confirms, false if they cancel or time out.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').Message} msg
 * @param {number} available
 * @param {number} requested
 * @returns {Promise<boolean>}
 */
async function askPoolConfirmation(interaction, msg, available, requested) {
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle('⚠️ عدد الأسئلة المتاحة أقل من المطلوب')
        .setDescription(
          `طلبت **${requested}** سؤالاً، لكن المتاح في الفئات المختارة **${available}** سؤال فقط.\n\n` +
          'هل تريد المتابعة بعدد الأسئلة المتاح؟'
        )
        .setColor(config.colors.warning),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pool_confirm')
          .setLabel(`متابعة بـ ${available} سؤال`)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('pool_cancel')
          .setLabel('إلغاء')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  return new Promise(resolve => {
    const poolCollector = msg.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id &&
                   (i.customId === 'pool_confirm' || i.customId === 'pool_cancel'),
      time: POOL_CONFIRM_TIMEOUT,
      max:  1,
    });

    poolCollector.on('collect', async i => {
      await i.deferUpdate();
      if (i.customId === 'pool_confirm') {
        resolve(true);
      } else {
        await interaction.editReply({
          content:    '❌ تم إلغاء الجلسة.',
          embeds:     [],
          components: [],
        });
        resolve(false);
      }
    });

    poolCollector.on('end', async (_, reason) => {
      if (reason === 'time') {
        await interaction.editReply({
          content:    '⏰ انتهت مهلة التأكيد. يرجى إعادة تشغيل الأمر.',
          embeds:     [],
          components: [],
        }).catch(() => {});
        resolve(false);
      }
    });
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SESSION LAUNCHER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate images, create the session, fetch the channel, and start the game.
 *
 * @param {object} opts
 */
async function launchSession({ interaction, guildId, client, settings, questions, timeLimitSec, categories }) {

  // ── Image validation ───────────────────────────────────────────────────────
  const invalidImageIds  = await validateQuestionImages(questions);
  const validatedQuestions = applyImageValidation(questions, invalidImageIds);

  if (validatedQuestions.length === 0) {
    await interaction.editReply({
      content:    '⛔ جميع الأسئلة المختارة تعذّر التحقق من صورها. يرجى المحاولة بفئات أخرى.',
      embeds:     [],
      components: [],
    });
    return;
  }

  // ── Create session ─────────────────────────────────────────────────────────
  const created = sm.createSession(guildId, {
    hostId:        interaction.user.id,
    channelId:     settings.session_channel,
    categories,
    questionCount: validatedQuestions.length,
    timeLimitSec,
    questions:     validatedQuestions,
  });

  if (!created) {
    // Race condition — another session was created in the last few milliseconds
    await interaction.editReply({
      content:    '⚠️ لا يمكن بدء الجلسة — هناك جلسة نشطة بالفعل.',
      embeds:     [],
      components: [],
    });
    return;
  }

  // ── Fetch session channel ──────────────────────────────────────────────────
  let channel;
  try {
    channel = await client.channels.fetch(settings.session_channel);
    if (!channel?.isTextBased()) throw new Error('Not a text channel');
  } catch {
    // Channel was deleted or bot lost access since setup
    sm.deleteSession(guildId);
    await interaction.editReply({
      content:
        '⛔ تعذّر الوصول إلى قناة الجلسة المعيّنة.\n' +
        'تأكد أن البوت يملك صلاحية القراءة والكتابة في القناة، ثم أعد المحاولة.',
      embeds:     [],
      components: [],
    });
    return;
  }

  // ── Confirm to the host ────────────────────────────────────────────────────
  await interaction.editReply({
    content:
      `✅ **بدأت الجلسة** في <#${settings.session_channel}>!\n` +
      `📋 ${validatedQuestions.length} سؤال | ⏱️ ${timeLimitSec} ثانية لكل سؤال`,
    embeds:     [],
    components: [],
  });

  // ── Start the game ─────────────────────────────────────────────────────────
  const session = sm.getSession(guildId);
  if (!session) return; // safety: deleted between create and fetch

  await startSession(client, session, channel);
}


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

  const managerRoles = parseJson(settings?.manager_roles, []);
  if (managerRoles.length === 0) return false;

  return interaction.member.roles.cache.some(r => managerRoles.includes(r.id));
}


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely parse a JSON string with a fallback value.
 *
 * @template T
 * @param {string|null|undefined} str
 * @param {T} fallback
 * @returns {T}
 */
function parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

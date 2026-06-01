'use strict';
/**
 * commands/slash/trivia-setup.js
 *
 * Full 6-step interactive setup wizard for configuring the bot in a guild.
 *
 * ─── Permission ──────────────────────────────────────────────────────────────
 *
 *   Requires Discord's built-in Administrator permission ONLY.
 *   This solves the chicken-and-egg problem: on first run, no manager
 *   roles are configured yet, so we can't use role-based checks.
 *
 * ─── Wizard steps ────────────────────────────────────────────────────────────
 *
 *   Step 1 — Session channel (ChannelSelect — text channels only)
 *   Step 2 — Backup channel (ChannelSelect + skip button)
 *   Step 3 — Manager roles (RoleSelect, multi — up to 10 + skip)
 *   Step 4 — Scheduling (StringSelect mode → time → weekdays if weekly)
 *             UTC NOTE displayed prominently in Arabic
 *   Step 5 — Categories (StringSelect multi + "all categories" skip)
 *   Step 6 — Review & Save (embed summary + Save / Abort buttons)
 *
 * ─── Implementation rules ────────────────────────────────────────────────────
 *
 *   ✓ All steps in one continuous message — no new messages per step.
 *   ✓ Settings saved ONLY on final "Save" confirm — no incremental saving.
 *   ✓ Wizard timeout: wizardTimeoutMs (2 min) per step — on expiry, edit
 *     the message to Arabic timeout notice and disable all buttons.
 *   ✓ Re-running the wizard any time is safe — changes apply to future
 *     sessions only, never to an active session.
 *   ✓ UTC scheduling note shown in Step 4 — admin is clearly informed.
 *   ✓ If scheduling wizard prerequisite fails in /trivia-schedule,
 *     an Arabic warning is shown and the wizard is aborted.
 *
 * ─── Scheduling prerequisite (for /trivia-schedule) ─────────────────────────
 *
 *   The step-4-only scheduling wizard is implemented in trivia-schedule.js.
 *   trivia-setup.js exports runSetupWizard() so the prefix router can
 *   call it directly.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const config    = require('../../config.json');
const queries   = require('../../database/queries');
const scheduler = require('../../scheduler/manager');

// ─── Wizard timeout ────────────────────────────────────────────────────────────
const WIZARD_TIMEOUT = config.wizardTimeoutMs ?? 120_000;

// ─── Step colours ─────────────────────────────────────────────────────────────
const STEP_COLOR  = config.colors.info;
const DONE_COLOR  = config.colors.success;
const WARN_COLOR  = config.colors.warning;
const ERROR_COLOR = config.colors.error;

// ─── UTC scheduling note (shown in Step 4) ────────────────────────────────────
const UTC_NOTE =
  '⚠️ **جميع الأوقات بتوقيت UTC** — يرجى تحويل وقتك المحلي قبل الإعداد.\n' +
  'مثال: إذا أردت الساعة 10 مساءً بتوقيت الرياض (UTC+3)، اختر **19:00 UTC**.';


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-setup')
    .setDescription('إعداد البوت في هذا السيرفر (يتطلب صلاحية Administrator)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await runSetupWizard(interaction);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN WIZARD RUNNER  (exported for prefix router)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the full 6-step setup wizard.
 * All state is local — nothing is saved until final "Save" confirmation.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 */
async function runSetupWizard(interaction) {
  // Draft — accumulates settings across steps, saved only at the end
  const draft = {
    session_channel:    null,
    backup_channel:     null,
    manager_roles:      [],
    schedule_mode:      'none',
    schedule_config:    {},
    enabled_categories: [],
  };

  // ── STEP 1: Session Channel ────────────────────────────────────────────────
  const step1Result = await runStep1(interaction, draft);
  if (!step1Result) return; // timed out or error

  // ── STEP 2: Backup Channel ─────────────────────────────────────────────────
  const step2Result = await runStep2(interaction, draft);
  if (!step2Result) return;

  // ── STEP 3: Manager Roles ──────────────────────────────────────────────────
  const step3Result = await runStep3(interaction, draft);
  if (!step3Result) return;

  // ── STEP 4: Scheduling ─────────────────────────────────────────────────────
  const step4Result = await runStep4(interaction, draft);
  if (!step4Result) return;

  // ── STEP 5: Categories ─────────────────────────────────────────────────────
  const step5Result = await runStep5(interaction, draft);
  if (!step5Result) return;

  // ── STEP 6: Review & Save ──────────────────────────────────────────────────
  await runStep6(interaction, draft);
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generic "wait for one component interaction" helper.
 * Returns the collected interaction, or null on timeout.
 *
 * @param {import('discord.js').Message} msg
 * @param {string} userId - only accept interactions from this user
 * @param {string[]} customIds - accepted customIds
 * @param {number} timeout
 * @returns {Promise<import('discord.js').MessageComponentInteraction | null>}
 */
function waitForComponent(msg, userId, customIds, timeout = WIZARD_TIMEOUT) {
  return new Promise(resolve => {
    const collector = msg.createMessageComponentCollector({
      filter: i => i.user.id === userId && customIds.includes(i.customId),
      time:   timeout,
      max:    1,
    });

    collector.on('collect', i => resolve(i));
    collector.on('end', (collected, reason) => {
      if (reason === 'time') resolve(null);
    });
  });
}

/**
 * Edit the wizard message to show a timeout notice and disable all components.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 */
async function showTimeoutNotice(interaction) {
  await interaction.editReply({
    content:    '⏰ **انتهت صلاحية الإعداد** — يرجى إعادة تشغيل الأمر `/trivia-setup`.',
    embeds:     [],
    components: [],
  }).catch(() => {});
}


// ─── STEP 1: Session Channel ───────────────────────────────────────────────────

async function runStep1(interaction, draft) {
  const userId = interaction.user.id;

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup_session_channel')
    .setPlaceholder('اختر قناة الجلسة...')
    .addChannelTypes(ChannelType.GuildText);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 1/6')
    .setDescription(
      '**📢 قناة الجلسة**\n\n' +
      'اختر القناة التي ستُنشر فيها أسئلة المسابقة وتفاعلات اللاعبين.\n\n' +
      '💡 تأكد أن البوت يملك صلاحية **القراءة** و**الكتابة** في القناة المختارة.'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'الخطوة 1 من 6 • ينتهي الإعداد خلال دقيقتين من عدم النشاط' });

  const msg = await interaction.editReply({
    embeds:     [embed],
    components: [new ActionRowBuilder().addComponents(channelSelect)],
    fetchReply: true,
  });

  const i = await waitForComponent(msg, userId, ['setup_session_channel']);
  if (!i) { await showTimeoutNotice(interaction); return false; }

  await i.deferUpdate();
  draft.session_channel = i.values[0];
  return true;
}


// ─── STEP 2: Backup Channel ────────────────────────────────────────────────────

async function runStep2(interaction, draft) {
  const userId = interaction.user.id;

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup_backup_channel')
    .setPlaceholder('اختر قناة احتياطية (اختياري)...')
    .addChannelTypes(ChannelType.GuildText);

  const skipBtn = new ButtonBuilder()
    .setCustomId('setup_skip_backup')
    .setLabel('تخطي — بدون قناة احتياطية')
    .setStyle(ButtonStyle.Secondary);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 2/6')
    .setDescription(
      '**🔁 القناة الاحتياطية** *(اختياري)*\n\n' +
      'اختر قناة بديلة تُستخدم إذا فقد البوت القدرة على الإرسال في قناة الجلسة.\n\n' +
      '• إذا تعذّر الإرسال في القناة الاحتياطية أيضاً، سيُرسل البوت DM للمضيف.\n' +
      '• يمكنك تخطي هذه الخطوة إذا لم تحتج لقناة احتياطية.'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'الخطوة 2 من 6' });

  const msg = await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(skipBtn),
    ],
    fetchReply: true,
  });

  const i = await waitForComponent(msg, userId, ['setup_backup_channel', 'setup_skip_backup']);
  if (!i) { await showTimeoutNotice(interaction); return false; }

  await i.deferUpdate();
  draft.backup_channel = i.customId === 'setup_backup_channel' ? i.values[0] : null;
  return true;
}


// ─── STEP 3: Manager Roles ────────────────────────────────────────────────────

async function runStep3(interaction, draft) {
  const userId = interaction.user.id;

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('setup_manager_roles')
    .setPlaceholder('اختر الأدوار المخوّلة (يمكن اختيار أكثر من دور)...')
    .setMinValues(1)
    .setMaxValues(10);

  const skipBtn = new ButtonBuilder()
    .setCustomId('setup_skip_roles')
    .setLabel('تخطي — Administrators فقط')
    .setStyle(ButtonStyle.Secondary);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 3/6')
    .setDescription(
      '**🛡️ أدوار الإدارة**\n\n' +
      'اختر الأدوار التي يُسمح لأصحابها ببدء وإيقاف وتخطي جلسات المسابقة.\n\n' +
      '• أصحاب صلاحية **Administrator** يمكنهم دائماً إدارة الجلسات بغض النظر.\n' +
      '• إذا تخطيت هذه الخطوة، ستكون إدارة الجلسات حكراً على الـ Administrators.\n' +
      '• يمكنك اختيار حتى **10 أدوار** مختلفة.'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'الخطوة 3 من 6' });

  const msg = await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(skipBtn),
    ],
    fetchReply: true,
  });

  const i = await waitForComponent(msg, userId, ['setup_manager_roles', 'setup_skip_roles']);
  if (!i) { await showTimeoutNotice(interaction); return false; }

  await i.deferUpdate();
  draft.manager_roles = i.customId === 'setup_manager_roles' ? i.values : [];
  return true;
}


// ─── STEP 4: Scheduling ────────────────────────────────────────────────────────

async function runStep4(interaction, draft) {
  const userId = interaction.user.id;

  // ── Sub-step 4a: Mode selection ───────────────────────────────────────────
  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId('setup_schedule_mode')
    .setPlaceholder('اختر وضع الجدولة...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('بدون جدولة')
        .setDescription('لا تبدأ الجلسات تلقائياً')
        .setValue('none')
        .setEmoji('🔕'),
      new StringSelectMenuOptionBuilder()
        .setLabel('يومي — وقت ثابت')
        .setDescription('تبدأ جلسة كل يوم على نفس الساعة بتوقيت UTC')
        .setValue('daily')
        .setEmoji('📅'),
      new StringSelectMenuOptionBuilder()
        .setLabel('أسبوعي — أيام محددة')
        .setDescription('تبدأ جلسة في أيام محددة من الأسبوع بتوقيت UTC')
        .setValue('weekly')
        .setEmoji('📆'),
    );

  const embed4a = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 4/6')
    .setDescription(
      '**📅 الجدولة التلقائية**\n\n' +
      UTC_NOTE + '\n\n' +
      'اختر كيف تريد جدولة الجلسات التلقائية:'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'الخطوة 4 من 6 • جميع الأوقات UTC' });

  let msg = await interaction.editReply({
    embeds:     [embed4a],
    components: [new ActionRowBuilder().addComponents(modeSelect)],
    fetchReply: true,
  });

  const i4a = await waitForComponent(msg, userId, ['setup_schedule_mode']);
  if (!i4a) { await showTimeoutNotice(interaction); return false; }

  await i4a.deferUpdate();
  draft.schedule_mode = i4a.values[0];

  // ── No scheduling → skip sub-steps ────────────────────────────────────────
  if (draft.schedule_mode === 'none') return true;

  // ── Sub-step 4b: UTC time selection ──────────────────────────────────────
  const timeOptions = Array.from({ length: 24 }, (_, h) => {
    const label = `${String(h).padStart(2, '0')}:00 UTC`;
    const desc  = h < 6  ? 'فجراً'
                : h < 12 ? 'صباحاً'
                : h < 18 ? 'مساءً'
                :           'ليلاً';
    return new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setDescription(desc)
      .setValue(`${String(h).padStart(2, '0')}:00`);
  });

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('setup_schedule_time')
    .setPlaceholder('اختر ساعة البداية (UTC)...')
    .addOptions(timeOptions);

  const embed4b = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 4/6 (وقت البداية)')
    .setDescription(
      '**🕐 وقت البداية**\n\n' +
      UTC_NOTE + '\n\n' +
      `الوضع المختار: **${draft.schedule_mode === 'daily' ? 'يومي' : 'أسبوعي'}**\n\n` +
      'اختر الساعة التي تبدأ فيها الجلسة كل يوم:'
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'الخطوة 4 من 6 • UTC فقط' });

  msg = await interaction.editReply({
    embeds:     [embed4b],
    components: [new ActionRowBuilder().addComponents(timeSelect)],
    fetchReply: true,
  });

  const i4b = await waitForComponent(msg, userId, ['setup_schedule_time']);
  if (!i4b) { await showTimeoutNotice(interaction); return false; }

  await i4b.deferUpdate();
  draft.schedule_config.utcTime = i4b.values[0];

  // ── Sub-step 4c: Weekdays (weekly mode only) ───────────────────────────────
  if (draft.schedule_mode === 'weekly') {
    const dayOptions = [
      { label: 'الأحد',     value: '0', emoji: '1️⃣' },
      { label: 'الاثنين',   value: '1', emoji: '2️⃣' },
      { label: 'الثلاثاء',  value: '2', emoji: '3️⃣' },
      { label: 'الأربعاء',  value: '3', emoji: '4️⃣' },
      { label: 'الخميس',    value: '4', emoji: '5️⃣' },
      { label: 'الجمعة',    value: '5', emoji: '6️⃣' },
      { label: 'السبت',     value: '6', emoji: '7️⃣' },
    ];

    const daySelect = new StringSelectMenuBuilder()
      .setCustomId('setup_schedule_days')
      .setPlaceholder('اختر الأيام (يمكن اختيار أكثر من يوم)...')
      .setMinValues(1)
      .setMaxValues(7)
      .addOptions(
        dayOptions.map(d =>
          new StringSelectMenuOptionBuilder()
            .setLabel(d.label)
            .setValue(d.value)
            .setEmoji(d.emoji)
        )
      );

    const embed4c = new EmbedBuilder()
      .setTitle('⚙️ إعداد البوت — الخطوة 4/6 (أيام الأسبوع)')
      .setDescription(
        '**📅 أيام الأسبوع**\n\n' +
        `الساعة المختارة: **${draft.schedule_config.utcTime} UTC**\n\n` +
        'اختر في أي أيام تبدأ الجلسة التلقائية:'
      )
      .setColor(STEP_COLOR)
      .setFooter({ text: 'الخطوة 4 من 6' });

    msg = await interaction.editReply({
      embeds:     [embed4c],
      components: [new ActionRowBuilder().addComponents(daySelect)],
      fetchReply: true,
    });

    const i4c = await waitForComponent(msg, userId, ['setup_schedule_days']);
    if (!i4c) { await showTimeoutNotice(interaction); return false; }

    await i4c.deferUpdate();
    draft.schedule_config.weekdays = i4c.values.map(Number).sort((a, b) => a - b);
  }

  return true;
}


// ─── STEP 5: Categories ───────────────────────────────────────────────────────

async function runStep5(interaction, draft) {
  const userId = interaction.user.id;

  const catSelect = new StringSelectMenuBuilder()
    .setCustomId('setup_categories')
    .setPlaceholder('اختر الفئات المفعّلة...')
    .setMinValues(1)
    .setMaxValues(config.categories.length)
    .addOptions(
      config.categories.map(c =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.nameAr)
          .setValue(c.id)
      )
    );

  const allCatsBtn = new ButtonBuilder()
    .setCustomId('setup_skip_cats')
    .setLabel('تفعيل كل الفئات')
    .setStyle(ButtonStyle.Primary);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 5/6')
    .setDescription(
      '**🗂️ فئات الأسئلة**\n\n' +
      'اختر الفئات التي تريد تفعيلها للجلسات في هذا السيرفر.\n\n' +
      '• يمكن لمن يبدأ الجلسة اختيار من الفئات **المفعّلة** فقط.\n' +
      '• اضغط **"تفعيل كل الفئات"** لتفعيل جميع الفئات المتاحة.\n\n' +
      `الفئات المتاحة (${config.categories.length}):\n` +
      config.categories.map(c => `• ${c.nameAr}`).join('\n')
    )
    .setColor(STEP_COLOR)
    .setFooter({ text: 'الخطوة 5 من 6' });

  const msg = await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(catSelect),
      new ActionRowBuilder().addComponents(allCatsBtn),
    ],
    fetchReply: true,
  });

  const i = await waitForComponent(msg, userId, ['setup_categories', 'setup_skip_cats']);
  if (!i) { await showTimeoutNotice(interaction); return false; }

  await i.deferUpdate();
  // Empty array = all categories (no restriction)
  draft.enabled_categories = i.customId === 'setup_categories' ? i.values : [];
  return true;
}


// ─── STEP 6: Review & Save ────────────────────────────────────────────────────

async function runStep6(interaction, draft) {
  const userId  = interaction.user.id;
  const guildId = interaction.guildId;

  // ── Build summary ─────────────────────────────────────────────────────────
  const catNames = draft.enabled_categories.length > 0
    ? draft.enabled_categories
        .map(id => config.categories.find(c => c.id === id)?.nameAr ?? id)
        .join('، ')
    : `كل الفئات (${config.categories.length})`;

  const rolesDisplay = draft.manager_roles.length > 0
    ? draft.manager_roles.map(r => `<@&${r}>`).join(' ')
    : 'Administrators فقط';

  const scheduleDisplay = buildScheduleDisplay(draft);

  const saveBtn = new ButtonBuilder()
    .setCustomId('setup_save')
    .setLabel('✅ حفظ الإعدادات')
    .setStyle(ButtonStyle.Success);

  const abortBtn = new ButtonBuilder()
    .setCustomId('setup_abort')
    .setLabel('❌ إلغاء بدون حفظ')
    .setStyle(ButtonStyle.Danger);

  const reviewEmbed = new EmbedBuilder()
    .setTitle('⚙️ إعداد البوت — الخطوة 6/6: المراجعة')
    .setDescription(
      '**راجع الإعدادات التالية قبل الحفظ:**\n\n' +
      '> التغييرات تسري على الجلسات القادمة فقط — لا تؤثر على الجلسة الحالية إن وجدت.'
    )
    .setColor(WARN_COLOR)
    .addFields(
      {
        name:   '📢 قناة الجلسة',
        value:  `<#${draft.session_channel}>`,
        inline: true,
      },
      {
        name:   '🔁 القناة الاحتياطية',
        value:  draft.backup_channel ? `<#${draft.backup_channel}>` : 'لا يوجد',
        inline: true,
      },
      {
        name:   '🛡️ أدوار الإدارة',
        value:  rolesDisplay,
        inline: false,
      },
      {
        name:   '📅 الجدولة',
        value:  scheduleDisplay,
        inline: false,
      },
      {
        name:   '🗂️ الفئات المفعّلة',
        value:  catNames,
        inline: false,
      },
    )
    .setFooter({ text: 'اضغط "حفظ" لتطبيق الإعدادات أو "إلغاء" للخروج بدون حفظ' });

  const msg = await interaction.editReply({
    embeds:     [reviewEmbed],
    components: [new ActionRowBuilder().addComponents(saveBtn, abortBtn)],
    fetchReply: true,
  });

  const i = await waitForComponent(msg, userId, ['setup_save', 'setup_abort']);
  if (!i) { await showTimeoutNotice(interaction); return; }

  await i.deferUpdate();

  // ── Abort ─────────────────────────────────────────────────────────────────
  if (i.customId === 'setup_abort') {
    await interaction.editReply({
      content:    '❌ **تم إلغاء الإعداد** — لم يتم حفظ أي تغييرات.',
      embeds:     [],
      components: [],
    });
    return;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  try {
    queries.upsertGuildSettings(guildId, {
      session_channel:    draft.session_channel,
      backup_channel:     draft.backup_channel,
      manager_roles:      JSON.stringify(draft.manager_roles),
      enabled_categories: JSON.stringify(draft.enabled_categories),
      schedule_mode:      draft.schedule_mode,
      schedule_config:    JSON.stringify(draft.schedule_config),
    });

    // Apply or cancel schedule
    if (draft.schedule_mode !== 'none') {
      scheduler.applySchedule(guildId, {
        mode:          draft.schedule_mode,
        utcTime:       draft.schedule_config.utcTime,
        weekdays:      draft.schedule_config.weekdays ?? [],
        questionCount: 10,
        timeLimitSec:  10,
        categories:    draft.enabled_categories,
      });
    } else {
      scheduler.removeSchedule(guildId);
    }

    // ── Success embed ──────────────────────────────────────────────────────
    await interaction.editReply({
      embeds: [
        EmbedBuilder.from(reviewEmbed)
          .setTitle('✅ تم حفظ الإعدادات بنجاح!')
          .setColor(DONE_COLOR)
          .setDescription(
            '**تم تطبيق إعدادات البوت في هذا السيرفر.**\n\n' +
            '🎮 يمكنك الآن بدء جلسة عبر `/trivia-start`\n' +
            '📊 لعرض الإحصائيات: `/trivia-stats`\n' +
            '❓ للمساعدة: `/trivia-help`'
          )
          .setFooter({ text: 'تم الحفظ بنجاح' }),
      ],
      components: [],
    });

  } catch (err) {
    console.error('[Setup] Failed to save settings:', err.message);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⛔ فشل حفظ الإعدادات')
          .setDescription(
            'حدث خطأ أثناء حفظ الإعدادات في قاعدة البيانات.\n' +
            `التفاصيل: \`${err.message}\`\n\n` +
            'يرجى المحاولة مجدداً أو التواصل مع مطور البوت.'
          )
          .setColor(ERROR_COLOR),
      ],
      components: [],
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a human-readable schedule description from the draft.
 *
 * @param {object} draft
 * @returns {string}
 */
function buildScheduleDisplay(draft) {
  if (draft.schedule_mode === 'none') {
    return '🔕 بدون جدولة تلقائية';
  }

  const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  if (draft.schedule_mode === 'daily') {
    return `📅 **يومي** — كل يوم الساعة **${draft.schedule_config.utcTime} UTC**`;
  }

  if (draft.schedule_mode === 'weekly') {
    const days = (draft.schedule_config.weekdays ?? [])
      .map(d => DAY_NAMES[d] ?? `يوم ${d}`)
      .join('، ');
    return `📆 **أسبوعي** — كل **${days}** الساعة **${draft.schedule_config.utcTime} UTC**`;
  }

  return draft.schedule_mode;
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.runSetupWizard = runSetupWizard;

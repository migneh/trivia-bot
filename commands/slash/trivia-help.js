'use strict';
/**
 * commands/slash/trivia-help.js
 *
 * Paginated help embed organised by command category.
 * Navigation via Previous / Next buttons.
 *
 * ─── Pages ───────────────────────────────────────────────────────────────────
 *
 *   1. الإعداد             (Setup)
 *   2. إدارة الجلسات       (Session Management)
 *   3. لوحة المتصدرين      (Leaderboard)
 *   4. الجدولة             (Scheduling)
 *   5. الملف والإنجازات    (Profile & Achievements)
 *   6. الإحصائيات          (Statistics)
 *
 * ─── Each page shows ─────────────────────────────────────────────────────────
 *
 *   For every command in the category:
 *     • Slash syntax:   /trivia-xxx
 *     • Prefix syntax:  !trivia xxx
 *     • Arabic description
 *     • Required permission level
 *     • Usage example in Arabic
 *
 * ─── Navigation ──────────────────────────────────────────────────────────────
 *
 *   ◀ Previous — disabled on page 1
 *   ▶ Next     — disabled on last page
 *   Collector timeout: 3 minutes (no wizard timeout — just navigation)
 *   On timeout: remove buttons silently.
 *
 * ─── Available to all members ────────────────────────────────────────────────
 *
 *   No permission requirement.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const config = require('../../config.json');

// ─── Navigation collector timeout ─────────────────────────────────────────────
const NAV_TIMEOUT = 3 * 60 * 1000; // 3 minutes

// ─── Prefix extracted from config ─────────────────────────────────────────────
const PREFIX = config.prefix ?? '!trivia';

// ─── Permission level labels ──────────────────────────────────────────────────
const PERM = {
  admin:   '🔐 Administrator',
  manager: '🛡️ أدوار الإدارة أو Administrator',
  all:     '🌍 جميع الأعضاء',
};


// ═══════════════════════════════════════════════════════════════════════════════
// HELP PAGES DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Each page object:
 *   title    — Arabic category title
 *   emoji    — icon for the title
 *   color    — embed colour
 *   commands — array of command entries
 *
 * Each command entry:
 *   slash    — slash command syntax (without /)
 *   prefix   — prefix subcommand (without !trivia)
 *   args     — optional args shown after the command
 *   desc     — Arabic description
 *   perm     — permission label from PERM
 *   example  — Arabic usage example
 */
const PAGES = [
  // ── Page 1: Setup ───────────────────────────────────────────────────────────
  {
    title:   'الإعداد',
    emoji:   '⚙️',
    color:   config.colors.info,
    intro:   'أوامر إعداد وتهيئة البوت في السيرفر. تتطلب صلاحية Administrator.',
    commands: [
      {
        slash:   'trivia-setup',
        prefix:  'setup',
        desc:
          'يفتح معالج الإعداد الكامل من 6 خطوات لتهيئة البوت:\n' +
          '• قناة الجلسة والقناة الاحتياطية\n' +
          '• أدوار الإدارة المخوّلة\n' +
          '• الجدولة التلقائية (UTC)\n' +
          '• الفئات المفعّلة في هذا السيرفر',
        perm:    PERM.admin,
        example: `\`/trivia-setup\` أو \`${PREFIX} setup\``,
      },
      {
        slash:   'trivia-schedule',
        prefix:  'schedule',
        desc:
          'يفتح معالج الجدولة التلقائية مباشرةً (بدون الخطوات الأخرى).\n' +
          '• يتطلب أن تكون قناة الجلسة معيّنة مسبقاً\n' +
          '• يدعم الجدولة اليومية والأسبوعية\n' +
          '• جميع الأوقات بتوقيت UTC',
        perm:    PERM.admin,
        example: `\`/trivia-schedule\` أو \`${PREFIX} schedule\``,
      },
    ],
  },

  // ── Page 2: Session Management ──────────────────────────────────────────────
  {
    title:   'إدارة الجلسات',
    emoji:   '🎮',
    color:   config.colors.success,
    intro:   'أوامر بدء وإدارة جلسات المسابقة. تتطلب أدوار الإدارة المعيّنة أو Administrator.',
    commands: [
      {
        slash:   'trivia-start',
        prefix:  'start',
        desc:
          'يفتح معالج بدء الجلسة التفاعلي:\n' +
          '• اختيار عدد الأسئلة (5 / 10 / 15 / 20 / 25 / 30)\n' +
          '• اختيار وقت الإجابة لكل سؤال (10–60 ثانية)\n' +
          '• اختيار فئة أو أكثر من الفئات المفعّلة\n' +
          '• تحقق تلقائي من الصور والأسئلة قبل البدء',
        perm:    PERM.manager,
        example: `\`/trivia-start\` أو \`${PREFIX} start\``,
      },
      {
        slash:   'trivia-stop',
        prefix:  'stop',
        desc:
          'يوقف الجلسة النشطة مع طلب تأكيد:\n' +
          '• في مرحلة التصويت: يعرض رسالة تأكيد (30 ثانية)\n' +
          '• في مرحلة الكشف: يُسجَّل الطلب وينتهي بعد انتهاء الكشف\n' +
          '• تُعرض النتائج الجزئية — بدون مكافأة الإكمال',
        perm:    PERM.manager,
        example: `\`/trivia-stop\` أو \`${PREFIX} stop\``,
      },
      {
        slash:   'trivia-skip',
        prefix:  'skip',
        desc:
          'يتخطى السؤال الحالي فوراً:\n' +
          '• بدون كشف الإجابة الصحيحة\n' +
          '• بدون أي تغيير في النقاط أو السلاسل\n' +
          '• السؤال المتخطى مستثنى من حساب مكافأة الإكمال\n' +
          '• لا تأخير — ينتقل فوراً للسؤال التالي',
        perm:    PERM.manager,
        example: `\`/trivia-skip\` أو \`${PREFIX} skip\``,
      },
    ],
  },

  // ── Page 3: Leaderboard ─────────────────────────────────────────────────────
  {
    title:   'لوحة المتصدرين',
    emoji:   '🏆',
    color:   config.colors.success,
    intro:   'عرض ترتيب اللاعبين حسب النقاط. متاح لجميع الأعضاء.',
    commands: [
      {
        slash:   'trivia-leaderboard',
        prefix:  'leaderboard',
        args:    '[day | week | month]',
        desc:
          'يعرض لوحة المتصدرين مع دعم الفترات الزمنية:\n' +
          '• **day** — المتصدرون اليوم (منذ 00:00 UTC)\n' +
          '• **week** — المتصدرون هذا الأسبوع (منذ الأحد 00:00 UTC)\n' +
          '• **month** — المتصدرون هذا الشهر\n' +
          '• **بدون وسيط** — يعرض الشهر الحالي (الافتراضي)\n\n' +
          'الترتيب يعالج التعادل بشكل صحيح.\n' +
          'يُظهر مركزك إذا لم تكن ضمن أعلى 10.',
        perm:    PERM.all,
        example:
          `\`/trivia-leaderboard week\`\n` +
          `\`${PREFIX} leaderboard day\``,
      },
    ],
  },

  // ── Page 4: Scheduling ──────────────────────────────────────────────────────
  {
    title:   'الجدولة',
    emoji:   '📅',
    color:   config.colors.info,
    intro:   'إعداد الجلسات التلقائية. جميع الأوقات بتوقيت UTC. يتطلب Administrator.',
    commands: [
      {
        slash:   'trivia-schedule',
        prefix:  'schedule',
        desc:
          'يفتح معالج الجدولة التلقائية:\n' +
          '• **يومي** — جلسة كل يوم على نفس الساعة (UTC)\n' +
          '• **أسبوعي** — جلسة في أيام محددة من الأسبوع (UTC)\n' +
          '• **إلغاء** — تعطيل الجدولة التلقائية\n\n' +
          '⚠️ **جميع الأوقات بتوقيت UTC:**\n' +
          '• السعودية/الخليج (UTC+3): اطرح 3 ساعات\n' +
          '• مصر (UTC+2): اطرح 2 ساعة\n' +
          '• المغرب (UTC+1): اطرح 1 ساعة\n\n' +
          'الجلسات المجدولة تبدأ تلقائياً بدون حضور أدمن.\n' +
          'إذا كانت هناك جلسة يدوية نشطة عند موعد الجلسة المجدولة، يُعطى تحذير قبل ' +
          `${config.schedulingWarningSeconds ?? 30} ثانية ثم تُلغى الجلسة اليدوية.`,
        perm:    PERM.admin,
        example:
          `\`/trivia-schedule\` أو \`${PREFIX} schedule\``,
      },
    ],
  },

  // ── Page 5: Profile & Achievements ─────────────────────────────────────────
  {
    title:   'الملف والإنجازات',
    emoji:   '👤',
    color:   config.colors.info,
    intro:   'عرض الملفات الشخصية والإنجازات. متاح لجميع الأعضاء.',
    commands: [
      {
        slash:   'trivia-profile',
        prefix:  'profile',
        args:    '[@user]',
        desc:
          'يعرض الملف الشخصي للاعب:\n' +
          '• اللقب الحالي (يتغير بزيادة النقاط)\n' +
          '• إجمالي النقاط والمركز في السيرفر\n' +
          '• عدد الجلسات، الانتصارات، نسبة الفوز\n' +
          '• إجمالي الإجابات الصحيحة\n' +
          '• أطول سلسلة إجابات صحيحة متتالية\n' +
          '• قائمة الإنجازات المفتوحة\n\n' +
          'بدون @user: يعرض ملفك الشخصي.\n' +
          'مع @user: يعرض ملف اللاعب المذكور (بياناته العامة فقط).',
        perm:    PERM.all,
        example:
          `\`/trivia-profile\` (ملفك)\n` +
          `\`/trivia-profile @أحمد\` (ملف أحمد)\n` +
          `\`${PREFIX} profile @أحمد\``,
      },
    ],
  },

  // ── Page 6: Statistics ──────────────────────────────────────────────────────
  {
    title:   'إحصائيات السيرفر',
    emoji:   '📊',
    color:   config.colors.info,
    intro:   'عرض إحصائيات المسابقة في هذا السيرفر. متاح لجميع الأعضاء.',
    commands: [
      {
        slash:   'trivia-stats',
        prefix:  'stats',
        desc:
          'يعرض إحصائيات شاملة للسيرفر:\n' +
          '• إجمالي عدد الجلسات المنتهية\n' +
          '• أكثر فئة أسئلة شعبية\n' +
          '• متوسط عدد اللاعبين لكل جلسة\n' +
          '• أكثر لاعب نشاطاً (عدد الجلسات)\n' +
          '• أصعب سؤال (أدنى نسبة إجابة صحيحة)\n' +
          '• أكثر سؤال تجاهلاً (لم يصوّت عليه أحد)',
        perm:    PERM.all,
        example: `\`/trivia-stats\` أو \`${PREFIX} stats\``,
      },
    ],
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-help')
    .setDescription('عرض قائمة الأوامر المصنّفة مع وصف كامل لكل أمر')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();
    await sendHelp(interaction, 0);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// HELP SENDER  (exported for prefix router)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send the paginated help embed and set up navigation.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {number} startPage - 0-based initial page index
 */
async function sendHelp(interaction, startPage = 0) {
  let currentPage = Math.max(0, Math.min(startPage, PAGES.length - 1));

  const msg = await interaction.editReply({
    embeds:     [buildPageEmbed(currentPage)],
    components: [buildNavRow(currentPage)],
    fetchReply: true,
  });

  // ── Navigation collector ───────────────────────────────────────────────────
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter:        i => i.user.id === interaction.user.id,
    time:          NAV_TIMEOUT,
  });

  collector.on('collect', async i => {
    if (i.customId === 'help_prev') currentPage = Math.max(0, currentPage - 1);
    if (i.customId === 'help_next') currentPage = Math.min(PAGES.length - 1, currentPage + 1);

    await i.update({
      embeds:     [buildPageEmbed(currentPage)],
      components: [buildNavRow(currentPage)],
    });
  });

  collector.on('end', () => {
    // Remove navigation buttons on timeout — no error if message was deleted
    interaction.editReply({ components: [] }).catch(() => {});
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// EMBED BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the embed for a single help page.
 *
 * @param {number} pageIndex - 0-based
 * @returns {EmbedBuilder}
 */
function buildPageEmbed(pageIndex) {
  const page  = PAGES[pageIndex];
  const total = PAGES.length;

  const embed = new EmbedBuilder()
    .setTitle(`${page.emoji} المساعدة — ${page.title}`)
    .setColor(page.color)
    .setFooter({ text: `الصفحة ${pageIndex + 1} من ${total} • ${page.title}` })
    .setTimestamp();

  // Page intro
  if (page.intro) {
    embed.setDescription(page.intro);
  }

  // One field per command
  for (const cmd of page.commands) {
    const argsStr   = cmd.args ? ` ${cmd.args}` : '';
    const fieldName =
      `\`/${cmd.slash}${argsStr}\`  ·  \`${PREFIX} ${cmd.prefix}${argsStr}\``;

    const fieldValue = [
      cmd.desc,
      '',
      `**الصلاحية:** ${cmd.perm}`,
      `**مثال:** ${cmd.example}`,
    ].join('\n');

    embed.addFields({ name: fieldName, value: fieldValue, inline: false });
  }

  return embed;
}

/**
 * Build the navigation button row for a given page.
 *
 * @param {number} pageIndex - 0-based
 * @returns {ActionRowBuilder}
 */
function buildNavRow(pageIndex) {
  const isFirst = pageIndex === 0;
  const isLast  = pageIndex === PAGES.length - 1;

  const prevBtn = new ButtonBuilder()
    .setCustomId('help_prev')
    .setLabel('◀ السابق')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isFirst);

  const pageBtn = new ButtonBuilder()
    .setCustomId('help_page_indicator')
    .setLabel(`${pageIndex + 1} / ${PAGES.length}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true); // display only

  const nextBtn = new ButtonBuilder()
    .setCustomId('help_next')
    .setLabel('التالي ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isLast);

  return new ActionRowBuilder().addComponents(prevBtn, pageBtn, nextBtn);
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.sendHelp = sendHelp;

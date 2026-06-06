'use strict';
/**
 * commands/slash/trivia-help.js
 *
 * Premium paginated help embed with:
 *   - Rich, engaging Arabic copywriting.
 *   - Pro-tips (💡 نصيحة) on every page.
 *   - Dropdown menu for quick category jumping.
 *   - Specific command search via optional argument.
 *   - Graceful timeout handling & Anti-hijack.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
} = require('discord.js');

const config = require('../../config.json');

const NAV_TIMEOUT = 3 * 60 * 1000; // 3 minutes
const PREFIX = config.prefix ?? '!trivia';

const PERM = {
  admin:   '🔐 Administrator',
  manager: '🛡️ أدوار الإدارة أو Administrator',
  all:     '🌍 جميع الأعضاء',
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELP PAGES DEFINITION (Enhanced Copywriting)
// ═══════════════════════════════════════════════════════════════════════════════

const PAGES = [
  // ── Page 1: Main Menu ──────────────────────────────────────────────────────
  {
    title: 'القائمة الرئيسية',
    emoji: '🏠',
    color: config.colors.info,
    intro: 
      'مرحباً بك في دليل مساعدة **Prometheus**! 🎉\n' +
      'بوت المسابقات الثقافية الأذكى والأكثر تفاعلية على Discord.\n\n' +
      'استخدم **القائمة المنسدلة** أدناه للتنقل بين الأقسام، أو استخدم الأزرار للتصفح.\n' +
      'يمكنك أيضاً البحث عن أمر معين مباشرة عبر كتابة:\n' +
      '`/trivia-help command:اسم_الأمر`',
    tip: '💡 **نصيحة:** ابدأ بإعداد البوت في سيرفرك عبر أمر `/trivia-setup` لتفعيل جميع الميزات.',
    commands: [
      {
        slash: 'trivia-help',
        prefix: 'help',
        args: '[command]',
        desc: 'يعرض دليل المساعدة هذا. إذا أضفت اسم أمر، سيظهر لك شرح مفصل له مباشرة.',
        perm: PERM.all,
        example: '`/trivia-help command:start`',
      },
    ],
  },

  // ── Page 2: Setup ──────────────────────────────────────────────────────────
  {
    title: 'إعداد البوت',
    emoji: '⚙️',
    color: 0x5865F2, // Discord Blurple
    intro: 'خطوتك الأولى لإطلاق العنان للمسابقات! تتطلب صلاحية **Administrator**.',
    tip: '💡 **نصيحة:** تأكد من منح البوت صلاحيات (إرسال الرسائل، تضمين الروابط، قراءة سجل الرسائل) في قناة الجلسة.',
    commands: [
      {
        slash: 'trivia-setup',
        prefix: 'setup',
        desc: 
          'يفتح **معالج إعداد تفاعلي** من 6 خطوات لتهيئة بيئة اللعب:\n' +
          '> • تحديد قناة المسابقات الرسمية.\n' +
          '> • تعيين قناة احتياطية (في حال فقدان الصلاحيات).\n' +
          '> • اختيار أدوار الإدارة المخوّلة بالتحكم في الجلسات.\n' +
          '> • تفعيل أو تعطيل فئات الأسئلة (تاريخ، رياضة، علوم...).',
        perm: PERM.admin,
        example: '`/trivia-setup`',
      },
    ],
  },

  // ── Page 3: Session Management ─────────────────────────────────────────────
  {
    title: 'إدارة الجلسات',
    emoji: '🎮',
    color: config.colors.success,
    intro: 'تحكم كامل في مجريات اللعب. تتطلب **أدوار الإدارة** المعيّنة مسبقاً.',
    tip: '💡 **نصيحة:** ابدأ بعدد قليل من الأسئلة (5 أو 10) لاختبار تفاعل الأعضاء قبل إطلاق جلسات طويلة.',
    commands: [
      {
        slash: 'trivia-start',
        prefix: 'start',
        desc: 
          'أطلق العنان للتحدي! يفتح واجهة لاختيار:\n' +
          '> • **عدد الأسئلة:** من 5 إلى 30 سؤالاً.\n' +
          '> • **وقت الإجابة:** من 10 إلى 60 ثانية.\n' +
          '> • **الفئات:** اختر فئة واحدة أو ادمج عدة فئات.\n' +
          'يتحقق البوت تلقائياً من توفر الأسئلة وصلاحية الصور قبل البدء.',
        perm: PERM.manager,
        example: '`/trivia-start`',
      },
      {
        slash: 'trivia-stop',
        prefix: 'stop',
        desc: 
          'إيقاف طارئ وآمن للجلسة النشطة:\n' +
          '> • يطلب تأكيداً لمنع الإيقاف العرضي.\n' +
          '> • يحفظ النقاط المكتسبة حتى لحظة الإيقاف.\n' +
          '> • يعرض لوحة النتائج النهائية فوراً (بدون مكافأة الإكمال).',
        perm: PERM.manager,
        example: '`/trivia-stop`',
      },
      {
        slash: 'trivia-skip',
        prefix: 'skip',
        desc: 
          'تخطي ذكي للسؤال الحالي:\n' +
          '> • مفيد إذا كان السؤال غير واضح أو يحتوي على خطأ.\n' +
          '> • **لا يكشف** الإجابة الصحيحة.\n' +
          '> • **لا يعاقب** اللاعبين (السلاسل والنقاط تبقى كما هي).\n' +
          '> • ينتقل للسؤال التالي فوراً بدون تأخير.',
        perm: PERM.manager,
        example: '`/trivia-skip`',
      },
    ],
  },

  // ── Page 4: Scheduling ─────────────────────────────────────────────────────
  {
    title: 'الجدولة التلقائية',
    emoji: '📅',
    color: 0xFEE75C, // Yellow
    intro: 'اجعل البوت يدير المسابقات نيابة عنك! يتطلب **Administrator**.',
    tip: '💡 **نصيحة:** البوت يستخدم توقيت UTC العالمي. لتحويل وقتك، استخدم موقع مثل timeanddate.com.',
    commands: [
      {
        slash: 'trivia-schedule',
        prefix: 'schedule',
        desc: 
          'برمج جلسات تلقائية تتكرر يومياً أو أسبوعياً:\n' +
          '> • **يومي:** جلسة كل يوم في نفس التوقيت.\n' +
          '> • **أسبوعي:** اختر أياماً محددة (مثلاً: الجمعة والسبت).\n\n' +
          '⏱️ **دليل تحويل التوقيت (UTC):**\n' +
          '• 🇸🇦 السعودية/العراق (UTC+3): اطرح 3 ساعات (مساءً 8 = 17:00)\n' +
          '• 🇪🇬 مصر (UTC+2): اطرح 2 ساعة (مساءً 8 = 18:00)\n' +
          '• 🇲🇦 المغرب (UTC+1): اطرح 1 ساعة (مساءً 8 = 19:00)',
        perm: PERM.admin,
        example: '`/trivia-schedule`',
      },
    ],
  },

  // ── Page 5: Leaderboard ────────────────────────────────────────────────────
  {
    title: 'لوحة المتصدرين',
    emoji: '🏆',
    color: 0xFFD700, // Gold
    intro: 'تتبع أبطال السيرفر وتنافس على القمة! متاح لـ **جميع الأعضاء**.',
    tip: '💡 **نصيحة:** استخدم لوحة الأسبوع (`week`) لمعرفة من هو اللاعب الأكثر نشاطاً حالياً.',
    commands: [
      {
        slash: 'trivia-leaderboard',
        prefix: 'leaderboard',
        args: '[day | week | month]',
        desc: 
          'استعرض ترتيب اللاعبين بناءً على النقاط المكتسبة:\n' +
          '> • **day** 🌅: أبطال اليوم (يتجدد عند منتصف الليل UTC).\n' +
          '> • **week** 🗓️: أبطال الأسبوع (يتجدد يوم الأحد UTC).\n' +
          '> • **month** 📆: أبطال الشهر.\n' +
          '> • **all** 🌟: الترتيب العام منذ بدء استخدام البوت.\n\n' +
          'النظام يعالج التعادل بذكاء، ويظهر مركزك الحالي حتى لو لم تكن في Top 10.',
        perm: PERM.all,
        example: '`/trivia-leaderboard week`',
      },
    ],
  },

  // ── Page 6: Profile & Achievements ─────────────────────────────────────────
  {
    title: 'الملف الشخصي',
    emoji: '👤',
    color: 0xEB459E, // Pink
    intro: 'اكتشف إحصائياتك واجمع شارات الإنجازات الحصرية! متاح لـ **جميع الأعضاء**.',
    tip: '💡 **نصيحة:** بعض الإنجازات سرية! حاول اللعب في أوقات مختلفة أو تحقيق سلاسل إجابات طويلة لفتحها.',
    commands: [
      {
        slash: 'trivia-profile',
        prefix: 'profile',
        args: '[@user]',
        desc: 
          'بطاقة تعريفية شاملة للاعب تحتوي على:\n' +
          '> • 🎖️ **اللقب:** يتطور تلقائياً بزيادة نقاطك.\n' +
          '> • 📊 **الأداء:** عدد الجلسات، الانتصارات، ونسبة الفوز.\n' +
          '> • 🔥 **السلاسل:** أطول سلسلة إجابات صحيحة متتالية.\n' +
          '> • 🏅 **الإنجازات:** الشارات التي فتحتها (مع عرض نسبتها).\n\n' +
          'يمكنك عرض ملفك، أو استعراض ملف أي لاعب آخر في السيرفر.',
        perm: PERM.all,
        example: '`/trivia-profile @أحمد`',
      },
    ],
  },

  // ── Page 7: Statistics ─────────────────────────────────────────────────────
  {
    title: 'إحصائيات السيرفر',
    emoji: '📊',
    color: 0x57F287, // Green
    intro: 'نظرة تحليلية عميقة على نشاط مجتمعك في المسابقات.',
    tip: '💡 **نصيحة:** استخدم هذه الإحصائيات لمعرفة الفئات المفضلة لدى أعضائك وزيادة أسئلتها.',
    commands: [
      {
        slash: 'trivia-stats',
        prefix: 'stats',
        desc: 
          'تقرير شامل يوضح نبض السيرفر:\n' +
          '> • 🎮 إجمالي عدد الجلسات والأسئلة المطروحة.\n' +
          '> • 📂 أكثر فئات الأسئلة شعبية.\n' +
          '> • 🧠 أصعب سؤال (أقل نسبة إجابات صحيحة).\n' +
          '> • 🏃‍♂️ أسرع إجابة مسجلة في تاريخ السيرفر.\n' +
          '> • 👑 أكثر لاعب نشاطاً من حيث عدد المشاركات.',
        perm: PERM.all,
        example: '`/trivia-stats`',
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
    .setDescription('عرض قائمة الأوامر والمساعدة')
    .addStringOption(option =>
      option.setName('command')
        .setDescription('اسم الأمر لعرض تفاصيله مباشرة (مثال: start)')
        .setRequired(false)
    )
    .setDMPermission(false),

  async execute(interaction) {
    await interaction.deferReply();
    const targetCommand = interaction.options.getString('command')?.toLowerCase();

    if (targetCommand) {
      await sendSpecificCommandHelp(interaction, targetCommand);
    } else {
      await sendHelp(interaction, 0);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SPECIFIC COMMAND SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

async function sendSpecificCommandHelp(interaction, query) {
  let foundCmd = null;
  let foundPage = null;

  for (const page of PAGES) {
    for (const cmd of page.commands) {
      if (cmd.slash.includes(query) || cmd.prefix.includes(query) || query.includes(cmd.prefix)) {
        foundCmd = cmd;
        foundPage = page;
        break;
      }
    }
    if (foundCmd) break;
  }

  if (!foundCmd) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔍 لم يتم العثور على الأمر')
          .setDescription(
            `عذراً، لا يوجد أمر يطابق البحث عن \`${query}\`.\n\n` +
            `**كيف تبحث بشكل صحيح؟**\n` +
            `اكتب اسم الأمر بدون الشرطة المائلة، مثال:\n` +
            `\`/trivia-help command:start\`\n\n` +
            `أو استخدم \`/trivia-help\` لتصفح جميع الأوامر.`
          )
          .setColor(config.colors.error)
      ]
    });
  }

  const argsStr = foundCmd.args ? ` ${foundCmd.args}` : '';
  const embed = new EmbedBuilder()
    .setAuthor({ name: `دليل الأوامر | ${foundCmd.slash}`, iconURL: interaction.client.user.displayAvatarURL() })
    .setColor(foundPage.color)
    .setDescription(`> ${foundCmd.desc}`)
    .addFields(
      { name: '📝 طريقة الاستخدام', value: `\`/${foundCmd.slash}${argsStr}\`\n\`${PREFIX} ${foundCmd.prefix}${argsStr}\``, inline: false },
      { name: '🔐 الصلاحية المطلوبة', value: foundCmd.perm, inline: true },
      { name: '💡 مثال عملي', value: foundCmd.example, inline: true }
    )
    .setFooter({ text: `الفئة: ${foundPage.emoji} ${foundPage.title}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGINATED HELP SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

async function sendHelp(interaction, startPage = 0) {
  let currentPage = Math.max(0, Math.min(startPage, PAGES.length - 1));
  const botAvatar = interaction.client.user.displayAvatarURL();

  const msg = await interaction.editReply({
    embeds: [buildPageEmbed(currentPage, botAvatar)],
    components: buildComponents(currentPage),
    fetchReply: true,
  });

  const filter = i => i.user.id === interaction.user.id;
  
  const collector = msg.createMessageComponentCollector({
    filter, time: NAV_TIMEOUT,
  });

  const handleNavigation = async (i, newPage) => {
    currentPage = newPage;
    await i.update({
      embeds: [buildPageEmbed(currentPage, botAvatar)],
      components: buildComponents(currentPage),
    }).catch(() => {});
  };

  collector.on('collect', async i => {
    if (i.isButton()) {
      if (i.customId === 'help_prev') await handleNavigation(i, Math.max(0, currentPage - 1));
      if (i.customId === 'help_next') await handleNavigation(i, Math.min(PAGES.length - 1, currentPage + 1));
    } else if (i.isStringSelectMenu()) {
      await handleNavigation(i, parseInt(i.values[0], 10));
    }
  });

  collector.on('end', async () => {
    try {
      const timeoutEmbed = buildPageEmbed(currentPage, botAvatar);
      timeoutEmbed.setFooter({ text: '⏰ انتهت صلاحية القائمة • استخدم /trivia-help لبدء تصفح جديد' });
      
      await interaction.editReply({
        embeds: [timeoutEmbed],
        components: buildComponents(currentPage, true), // Disable all
      });
    } catch (err) {
      if (err.code !== 10008) console.error('[Help Timeout Error]', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildPageEmbed(pageIndex, botAvatar) {
  const page = PAGES[pageIndex];
  const embed = new EmbedBuilder()
    .setAuthor({ name: 'دليل مساعدة Trivia Bot', iconURL: botAvatar })
    .setTitle(`${page.emoji} ${page.title}`)
    .setColor(page.color)
    .setDescription(page.intro)
    .setFooter({ text: `الصفحة ${pageIndex + 1} من ${PAGES.length}` })
    .setTimestamp();

  if (page.tip) {
    embed.addFields({ name: '\u200B', value: page.tip, inline: false });
  }

  for (const cmd of page.commands) {
    const argsStr = cmd.args ? ` ${cmd.args}` : '';
    const fieldName = `/${cmd.slash}${argsStr}`;
    const fieldValue = 
      `${cmd.desc}\n\n` +
      `**الصلاحية:** ${cmd.perm}\n` +
      `**مثال:** ${cmd.example}`;
    
    embed.addFields({ name: fieldName, value: fieldValue, inline: false });
  }

  return embed;
}

function buildComponents(pageIndex, disabled = false) {
  const isFirst = pageIndex === 0;
  const isLast = pageIndex === PAGES.length - 1;

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('الانتقال السريع إلى قسم...')
    .setDisabled(disabled)
    .addOptions(PAGES.map((p, idx) => {
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(`${p.emoji} ${p.title}`)
        .setValue(String(idx));
      if (idx === pageIndex) opt.setDefault(true);
      return opt;
    }));

  const prevBtn = new ButtonBuilder()
    .setCustomId('help_prev').setLabel('◀ السابق').setStyle(ButtonStyle.Secondary).setDisabled(isFirst || disabled);

  const pageBtn = new ButtonBuilder()
    .setCustomId('help_page_indicator').setLabel(`${pageIndex + 1} / ${PAGES.length}`).setStyle(ButtonStyle.Primary).setDisabled(true);

  const nextBtn = new ButtonBuilder()
    .setCustomId('help_next').setLabel('التالي ▶').setStyle(ButtonStyle.Secondary).setDisabled(isLast || disabled);

  return [
    new ActionRowBuilder().addComponents(selectMenu),
    new ActionRowBuilder().addComponents(prevBtn, pageBtn, nextBtn),
  ];
}

module.exports.sendHelp = sendHelp;

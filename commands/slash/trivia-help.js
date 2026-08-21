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
// HELP PAGES DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

const PAGES = [
  // ── Page 1: Main Menu ──────────────────────────────────────────────────────
  {
    title: 'القائمة الرئيسية',
    emoji: '🏠',
    color: config.colors.info,
    intro: 
      'مرحباً بك في منصة **Trivia Bot** الضخمة! 🎉\n' +
      'المنصة الثقافية والتنافسية الأولى على ديسكورد بأكثر من 5,000 سؤال موثق.\n\n' +
      'استخدم **القائمة المنسدلة** أدناه للتنقل بين الأقسام، أو استخدم الأزرار للتصفح.\n' +
      'يمكنك أيضاً البحث عن أمر معين مباشرة عبر:\n' +
      '`/trivia-help command:اسم_الأمر`',
    tip: '💡 **نصيحة:** استكشف أطوار اللعب المتنوعة مثل البقاء وحرب الفرق والمبارزات لكسب المزيد من الدنانير!',
    commands: [
      {
        slash: 'trivia-help',
        prefix: 'help',
        args: '[command]',
        desc: 'يعرض دليل المساعدة الشامل. يمكنك كتابة اسم أي أمر لمعرفة تفاصيله.',
        perm: PERM.all,
        example: '`/trivia-help command:duel`',
      },
      {
        slash: 'trivia-dashboard',
        prefix: 'dashboard',
        desc: 'يعرض رابط لوحة التحكم المباشرة على الويب وإحصائيات البنك الشاملة.',
        perm: PERM.all,
        example: '`/trivia-dashboard`',
      },
    ],
  },

  // ── Page 2: Game Modes ─────────────────────────────────────────────────────
  {
    title: 'أطوار اللعب والتحديات',
    emoji: '⚔️',
    color: config.colors.purple,
    intro: 'تشكيلة متكاملة من أطوار المسابقات التنافسية للأفراد والمجموعات:',
    tip: '💡 **نصيحة:** في طور البقاء، احرص على سرعة الإجابة وتجنب التخمين غير المحسوب للحفاظ على قلوبك الثلاثة.',
    commands: [
      {
        slash: 'trivia-start',
        prefix: 'start',
        desc: 'إطلاق النمط الكلاسيكي مع واجهة كاملة لاختيار الفئات والوقت وعدد الأسئلة.',
        perm: PERM.manager,
        example: '`/trivia-start`',
      },
      {
        slash: 'trivia-survival',
        prefix: 'survival',
        args: '[questions:15]',
        desc: 'طور البقاء (Battle Royale) — يبدأ كل لاعب بـ 3 قلوب، والخطأ يكلفك قلباً حتى يتبقى فائز واحد!',
        perm: PERM.all,
        example: '`/trivia-survival questions:20`',
      },
      {
        slash: 'trivia-teams',
        prefix: 'teams',
        args: '[questions:10]',
        desc: 'حرب الفرق — مواجهة كبرى بين الصقور 🔴 والنمور 🔵 والأبطال 🟢 مع جوائز للمجموعة وMVP.',
        perm: PERM.all,
        example: '`/trivia-teams questions:10`',
      },
      {
        slash: 'trivia-duel',
        prefix: 'duel',
        args: '<@opponent> [stake] [category]',
        desc: 'مبارزة 1 ضد 1 وجهاً لوجه على 5 أسئلة سريعة ورهان دنانير ذهبية!',
        perm: PERM.all,
        example: '`/trivia-duel opponent:@أحمد stake:100`',
      },
    ],
  },

  // ── Page 3: Economy & RPG ──────────────────────────────────────────────────
  {
    title: 'الاقتصاد والمتجر والمكافآت',
    emoji: '🛍️',
    color: config.colors.gold,
    intro: 'اكسب الدنانير، طوّر مستواك، واشترِ القدرات الخاصة من المتجر:',
    tip: '💡 **نصيحة:** احرص على تفعيل /trivia-daily يومياً للحفاظ على السلسلة ومضاعفة الأرباح!',
    commands: [
      {
        slash: 'trivia-daily',
        prefix: 'daily',
        desc: 'استلام المكافأة اليومية المجانية ومضاعفة السلسلة.',
        perm: PERM.all,
        example: '`/trivia-daily`',
      },
      {
        slash: 'trivia-shop',
        prefix: 'shop',
        desc: 'تصفح المتجر وشراء القدرات (حذف إجابتين 50:50، مضاعف النقاط 2x، درع السلسلة، تجميد الوقت).',
        perm: PERM.all,
        example: '`/trivia-shop`',
      },
      {
        slash: 'trivia-inventory',
        prefix: 'inventory',
        desc: 'عرض حقيبة أدواتك وقدراتك المشتراة من المتجر.',
        perm: PERM.all,
        example: '`/trivia-inventory`',
      },
      {
        slash: 'trivia-economy',
        prefix: 'economy',
        args: '<balance | transfer | top>',
        desc: 'الاطلاع على الرصيد والمستوى، تحويل الدنانير، وقائمة أثرياء السيرفر.',
        perm: PERM.all,
        example: '`/trivia-economy balance`',
      },
      {
        slash: 'trivia-quest',
        prefix: 'quest',
        desc: 'عرض المهام اليومية والأسبوعية واستلام مكافآت الإنجاز.',
        perm: PERM.all,
        example: '`/trivia-quest`',
      },
      {
        slash: 'trivia-season',
        prefix: 'season',
        desc: 'عرض تقدمك في تصريح الموسم (Battle Pass) وجوائز المستويات.',
        perm: PERM.all,
        example: '`/trivia-season`',
      },
    ],
  },

  // ── Page 4: Clans & Custom Questions ───────────────────────────────────────
  {
    title: 'الكلانات والأسئلة المخصصة',
    emoji: '🛡️',
    color: config.colors.teamBlue,
    intro: 'أنشئ تحالفك الخاص أو أضف أسئلتك المخصصة للسيرفر:',
    tip: '💡 **نصيحة:** تنافس مع أعضاء كلانك لرفع ترتيب الكلان في صدارة السيرفر!',
    commands: [
      {
        slash: 'trivia-clan',
        prefix: 'clan',
        args: '<create | join | info | leave | top>',
        desc: 'تأسيس كلان، الانضمام عبر التاغ، عرض المعلومات، وصدارة الكلانات.',
        perm: PERM.all,
        example: '`/trivia-clan create name:الفرسان tag:FRS`',
      },
      {
        slash: 'trivia-custom',
        prefix: 'custom',
        args: '<add | createpack | list>',
        desc: 'إضافة أسئلة خاصة بالسيرفر وإنشاء حزم مخصصة.',
        perm: PERM.manager,
        example: '`/trivia-custom add question:سؤال...`',
      },
    ],
  },

  // ── Page 5: Setup & Administration ─────────────────────────────────────────
  {
    title: 'الإعداد والإدارة',
    emoji: '⚙️',
    color: 0x5865F2,
    intro: 'إعدادات متقدمة لإدارة الجلسات والجدولة التلقائية:',
    tip: '💡 **نصيحة:** عيّن قناة احتياطية لضمان عدم توقف المسابقات في حال حدوث أي خلل في الصلاحيات.',
    commands: [
      {
        slash: 'trivia-setup',
        prefix: 'setup',
        desc: 'معالج الإعداد التفاعلي لتحديد القنوات والأدوار والفئات.',
        perm: PERM.admin,
        example: '`/trivia-setup`',
      },
      {
        slash: 'trivia-schedule',
        prefix: 'schedule',
        desc: 'جدولة جلسات تلقائية متكررة (يومية أو أسبوعية).',
        perm: PERM.admin,
        example: '`/trivia-schedule`',
      },
      {
        slash: 'trivia-stop',
        prefix: 'stop',
        desc: 'إيقاف طارئ وآمن للجلسة النشطة وحفظ النقاط الحالية.',
        perm: PERM.manager,
        example: '`/trivia-stop`',
      },
      {
        slash: 'trivia-skip',
        prefix: 'skip',
        desc: 'تخطي السؤال الحالي فوراً دون كشف الإجابة أو معاقبة السلاسل.',
        perm: PERM.manager,
        example: '`/trivia-skip`',
      },
    ],
  },

  // ── Page 6: Stats & Profiles ───────────────────────────────────────────────
  {
    title: 'الإحصائيات والملفات الشخصية',
    emoji: '🏆',
    color: 0x57F287,
    intro: 'تتبع تقدمك وتنافس على لوحات الصدارة:',
    tip: '💡 **نصيحة:** كلما زادت نقاطك، يرتقي لقبك من 🌱 المبتدئ وصولاً إلى ☀️ الشمس التي لا تغيب.',
    commands: [
      {
        slash: 'trivia-leaderboard',
        prefix: 'leaderboard',
        args: '[day | week | month | all]',
        desc: 'عرض لوحة صدارة النقاط حسب الفترات الزمنية أو الترتيب العام.',
        perm: PERM.all,
        example: '`/trivia-leaderboard all`',
      },
      {
        slash: 'trivia-profile',
        prefix: 'profile',
        args: '[@user]',
        desc: 'بطاقة اللاعب الشاملة (المستوى، اللقب، الإنجازات، ونسبة الفوز).',
        perm: PERM.all,
        example: '`/trivia-profile`',
      },
      {
        slash: 'trivia-stats',
        prefix: 'stats',
        desc: 'إحصائيات شاملة عن نشاط السيرفر والأسئلة الأكثر صعوبة وتكراراً.',
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
    .setDescription('عرض دليل المساعدة وقائمة الأوامر الشاملة')
    .addStringOption(option =>
      option.setName('command')
        .setDescription('اسم الأمر لعرض تفاصيله مباشرة (مثال: duel, start, shop)')
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
          .setDescription(`عذراً، لا يوجد أمر يطابق البحث عن \`${query}\`.\nاستخدم \`/trivia-help\` لتصفح جميع الأقسام.`)
          .setColor(config.colors.error)
      ]
    });
  }

  const argsStr = foundCmd.args ? ` ${foundCmd.args}` : '';
  const embed = new EmbedBuilder()
    .setAuthor({ name: `دليل الأوامر | ${foundCmd.slash}`, iconURL: interaction.client.user?.displayAvatarURL() })
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

async function sendHelp(interaction, startPage = 0) {
  let currentPage = Math.max(0, Math.min(startPage, PAGES.length - 1));
  const botAvatar = interaction.client.user?.displayAvatarURL();

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
        components: buildComponents(currentPage, true),
      });
    } catch (err) {
      if (err.code !== 10008) console.error('[Help Timeout Error]', err.message);
    }
  });
}

function buildPageEmbed(pageIndex, botAvatar) {
  const page = PAGES[pageIndex];
  const embed = new EmbedBuilder()
    .setTitle(`${page.emoji} ${page.title}`)
    .setColor(page.color)
    .setDescription(page.intro)
    .setFooter({ text: `الصفحة ${pageIndex + 1} من ${PAGES.length}` })
    .setTimestamp();

  if (botAvatar) {
    embed.setAuthor({ name: 'منصة مسابقات Trivia Bot الضخمة', iconURL: botAvatar });
  }

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

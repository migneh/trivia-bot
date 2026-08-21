'use strict';
/**
 * commands/slash/trivia-custom.js
 * Slash command: /trivia-custom
 * Manage custom questions and server question packs.
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const queries = require('../../database/queries');
const customManager = require('../../utils/customPacksManager');
const config = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-custom')
  .setDescription('📦 إدارة الأسئلة وحزم الأسئلة المخصصة للسيرفر')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('➕ إضافة سؤال مخصص جديد إلى حزمة في السيرفر')
      .addStringOption(opt => opt.setName('question').setDescription('نص السؤال').setRequired(true))
      .addStringOption(opt => opt.setName('option1').setDescription('الخيار الأول').setRequired(true))
      .addStringOption(opt => opt.setName('option2').setDescription('الخيار الثاني').setRequired(true))
      .addStringOption(opt => opt.setName('option3').setDescription('الخيار الثالث').setRequired(true))
      .addStringOption(opt => opt.setName('option4').setDescription('الخيار الرابع').setRequired(true))
      .addIntegerOption(opt =>
        opt.setName('correct')
          .setDescription('رقم الخيار الصحيح (1 إلى 4)')
          .setMinValue(1)
          .setMaxValue(4)
          .setRequired(true)
      )
      .addStringOption(opt => opt.setName('pack').setDescription('اسم الحزمة المخصصة (الافتراضي: general)').setRequired(false))
      .addStringOption(opt =>
        opt.setName('difficulty')
          .setDescription('مستوى الصعوبة')
          .addChoices(
            { name: 'سهل 🟢', value: 'easy' },
            { name: 'متوسط 🟡', value: 'medium' },
            { name: 'صعب 🔴', value: 'hard' }
          )
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName('createpack')
      .setDescription('📁 إنشاء حزمة أسئلة مخصصة جديدة للسيرفر')
      .addStringOption(opt => opt.setName('id').setDescription('معرف الحزمة بالإنجليزية (مثال: anime, gaming)').setRequired(true))
      .addStringOption(opt => opt.setName('name').setDescription('اسم الحزمة بالعربي').setRequired(true))
      .addStringOption(opt => opt.setName('description').setDescription('وصف الحزمة').setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('📋 عرض جميع حزم الأسئلة المخصصة وإحصائياتها')
  );

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const text = interaction.options.getString('question');
    const opt1 = interaction.options.getString('option1');
    const opt2 = interaction.options.getString('option2');
    const opt3 = interaction.options.getString('option3');
    const opt4 = interaction.options.getString('option4');
    const correctNum = interaction.options.getInteger('correct');
    const packName = interaction.options.getString('pack') || 'general';
    const difficulty = interaction.options.getString('difficulty') || 'medium';

    const res = customManager.addCustomQuestion(guildId, userId, {
      text,
      options: [opt1, opt2, opt3, opt4],
      correctAnswer: correctNum - 1,
      packName,
      difficulty,
    });

    if (!res.success) {
      await interaction.reply({ content: `❌ خطأ في التحقق من السؤال: ${res.error}`, ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ تمت إضافة السؤال المخصص بنجاح!')
      .setDescription(
        `**السؤال:** ${text}\n` +
        `**الحزمة:** \`${packName}\` | **الصعوبة:** \`${difficulty}\`\n\n` +
        `1. ${opt1} ${correctNum === 1 ? '✅' : ''}\n` +
        `2. ${opt2} ${correctNum === 2 ? '✅' : ''}\n` +
        `3. ${opt3} ${correctNum === 3 ? '✅' : ''}\n` +
        `4. ${opt4} ${correctNum === 4 ? '✅' : ''}`
      )
      .setColor(config.colors.success)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'createpack') {
    const id = interaction.options.getString('id');
    const name = interaction.options.getString('name');
    const desc = interaction.options.getString('description') || '';

    const res = customManager.createPack(guildId, userId, id, name, desc);
    if (!res.success) {
      await interaction.reply({ content: `❌ ${res.error || 'الحزمة موجودة بالفعل.'}`, ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📁 تم إنشاء حزمة الأسئلة بنجاح!')
      .setDescription(`الحزمة: **${name}** (\`${id}\`)\nالوصف: ${desc || 'لا يوجد'}`)
      .setColor(config.colors.success)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'list') {
    const packs = queries.getCustomPacks(guildId);

    if (!packs || packs.length === 0) {
      await interaction.reply({
        content: 'ℹ️ لا توجد حزم مخصصة بعد. استخدم `/trivia-custom createpack` لإنشاء حزمتك الأولى!',
        ephemeral: true,
      });
      return;
    }

    const lines = packs.map(p =>
      `• **${p.icon_emoji || '📦'} ${p.display_name}** (\`${p.pack_name}\`) — **${p.question_count}** سؤال\n  _${p.description || 'لا يوجد وصف'}_`
    );

    const embed = new EmbedBuilder()
      .setTitle('📋 حزم الأسئلة المخصصة للسيرفر')
      .setDescription(lines.join('\n\n'))
      .setColor(config.colors.info)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}

module.exports = { data, execute };

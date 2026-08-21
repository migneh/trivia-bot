'use strict';
/**
 * commands/slash/trivia-clan.js
 * Slash command: /trivia-clan
 * Create, join, view and manage clans.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const queries = require('../../database/queries');
const clanManager = require('../../utils/clanManager');
const config = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-clan')
  .setDescription('🛡️ نظام الكلانات والتحالفات التنافسية')
  .addSubcommand(sub =>
    sub.setName('create')
      .setDescription('⚔️ إنشاء كلان جديد (التكلفة: 500 دينار)')
      .addStringOption(opt => opt.setName('name').setDescription('اسم الكلان (3 - 24 حرف)').setRequired(true))
      .addStringOption(opt => opt.setName('tag').setDescription('تاغ الكلان (2 - 5 أحرف إنجليزية)').setRequired(true))
      .addStringOption(opt => opt.setName('emoji').setDescription('رمز/إيموجي الكلان (مثال: 🦅)').setRequired(false))
      .addStringOption(opt => opt.setName('description').setDescription('وصف أو شعار الكلان').setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName('info')
      .setDescription('ℹ️ عرض معلومات الكلان الحالي أو كلان معين')
      .addStringOption(opt => opt.setName('tag').setDescription('تاغ الكلان للاستعلام عنه (اختياري)').setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName('join')
      .setDescription('🤝 الانضمام إلى كلان باستخدام التاغ')
      .addStringOption(opt => opt.setName('tag').setDescription('تاغ الكلان').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('leave')
      .setDescription('🚪 مغادرة الكلان الحالي')
  )
  .addSubcommand(sub =>
    sub.setName('top')
      .setDescription('🏆 لوحة صدارة أفضل الكلانات في السيرفر')
  );

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const name = interaction.options.getString('name');
    const tag = interaction.options.getString('tag');
    const emoji = interaction.options.getString('emoji') || '🛡️';
    const description = interaction.options.getString('description') || '';

    const res = clanManager.createNewClan(guildId, userId, name, tag, emoji, description);

    if (!res.success) {
      if (res.reason === 'already_in_clan') {
        await interaction.reply({ content: '❌ أنت عضو بالفعل في كلان آخر! غادر كلانك أولاً لتتمكن من إنشاء كلان.', ephemeral: true });
      } else if (res.reason === 'insufficient_coins') {
        await interaction.reply({ content: `❌ لا تملك دنانير كافية لإنشاء كلان! التكلفة: **${res.cost}** دينار، ورصيدك: **${res.currentCoins}** دينار.`, ephemeral: true });
      } else if (res.reason === 'invalid_tag_length') {
        await interaction.reply({ content: '❌ يجب أن يكون تاغ الكلان بين 2 و 5 أحرف إنجليزية.', ephemeral: true });
      } else if (res.reason === 'already_exists') {
        await interaction.reply({ content: '❌ يوجد كلان بنفس الاسم أو التاغ بالفعل!', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ فشل إنشاء الكلان.', ephemeral: true });
      }
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎉 تم تأسيس كلان ${emoji} ${name} [${tag.toUpperCase()}] بنجاح!`)
      .setDescription(
        `القائد: <@${userId}>\n` +
        `الشعار: ${description || 'لا يوجد وصف بعد'}\n\n` +
        `يمكن لبقية الأعضاء الانضمام عبر الأمر:\n` +
        `\`/trivia-clan join tag:${tag.toUpperCase()}\``
      )
      .setColor(config.colors.gold)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'join') {
    const tag = interaction.options.getString('tag');
    const targetClan = queries.getClanByTag(guildId, tag);

    if (!targetClan) {
      await interaction.reply({ content: `❌ لم يتم العثور على كلان بالتاغ [${tag.toUpperCase()}].`, ephemeral: true });
      return;
    }

    const res = queries.addClanMember(guildId, targetClan.id, userId);
    if (!res.success) {
      await interaction.reply({ content: '❌ أنت بالفعل عضو في هذا الكلان أو في كلان آخر!', ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🤝 انضمام ناجح للكلان!')
      .setDescription(`لقد انضم <@${userId}> إلى كلان **${targetClan.banner_emoji} ${targetClan.name} [${targetClan.tag}]** بنجاح!`)
      .setColor(config.colors.success)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'leave') {
    const res = queries.removeClanMember(guildId, userId);
    if (!res.success) {
      await interaction.reply({ content: '❌ أنت لست عضواً في أي كلان حالياً.', ephemeral: true });
      return;
    }

    if (res.clanDisbanded) {
      await interaction.reply('⚠️ بما أنك قائد الكلان، فقد تم تفكيك الكلان وحذف جميع بياناته.');
    } else {
      await interaction.reply('✅ لقد غادرت الكلان بنجاح.');
    }
    return;
  }

  if (sub === 'info') {
    const tag = interaction.options.getString('tag');
    let clan = tag ? queries.getClanByTag(guildId, tag) : queries.getUserClan(guildId, userId);

    if (!clan) {
      await interaction.reply({ content: '❌ لم يتم العثور على الكلان أو أنك لست منضماً لأي كلان.', ephemeral: true });
      return;
    }

    const members = queries.getClanMembers(clan.id);
    const memberLines = members.slice(0, 10).map((m, idx) => {
      const roleIcon = m.role === 'leader' ? '👑' : '⚔️';
      return `${idx + 1}. ${roleIcon} <@${m.user_id}> — **${m.points_contrib}** نقطة`;
    });

    const level = clanManager.getClanLevel(clan.score);

    const embed = new EmbedBuilder()
      .setTitle(`${clan.banner_emoji} ${clan.name} [${clan.tag}]`)
      .setDescription(clan.description || 'كلان تنافسي في مسابقات المعرفة.')
      .setColor(config.colors.purple)
      .addFields(
        { name: '👑 القائد', value: `<@${clan.leader_id}>`, inline: true },
        { name: '🏆 نقاط الكلان', value: `**${clan.score.toLocaleString('ar-EG')}** نقطة`, inline: true },
        { name: '⭐ مستوى الكلان', value: `المستوى **${level}**`, inline: true },
        { name: `👥 الأعضاء (${members.length})`, value: memberLines.join('\n') || 'لا يوجد أعضاء', inline: false }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'top') {
    const topClans = queries.getTopClans(guildId, 10);
    if (!topClans || topClans.length === 0) {
      await interaction.reply('لا توجد كلانات مسجلة بعد في هذا السيرفر.');
      return;
    }

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const lines = topClans.map((c, idx) => {
      const medal = medals[idx] || `**${idx + 1}.**`;
      return `${medal} **${c.banner_emoji} ${c.name}** [${c.tag}] — 🏆 **${c.score.toLocaleString('ar-EG')}** نقطة (${c.member_count} عضو)`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🛡️ صدارة أفضل الكلانات (Top Clans)')
      .setDescription(lines.join('\n'))
      .setColor(config.colors.gold)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}

module.exports = { data, execute };

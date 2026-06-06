'use strict';
/**
 * commands/slash/trivia-start.js
 *
 * تحسينات مطبقة:
 * 1. فحص صلاحيات البوت في قناة الجلسة مبكراً (Pre-flight check).
 * 2. التحديد التلقائي للفئة إذا كانت هناك فئة واحدة فقط مفعلة.
 * 3. عرض أسماء الفئات المختارة في الـ Embed بدلاً من العدد فقط.
 * 4. منع النقر المزدوج (Race Condition) عبر تعطيل الأزرار فور الضغط عليها.
 * 5. التعامل مع خطأ 10008 (حذف الرسالة) لمنع انهيار البوت.
 * 6. تحسين فلتر الـ Collector لتقليل العبء.
 */

const {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} = require('discord.js');

const config   = require('../../config.json');
const sm       = require('../../utils/sessionManager');
const qb       = require('../../utils/questionBank');
const { validateQuestionImages, applyImageValidation } = require('../../utils/imageValidator');
const { startSession } = require('../../utils/gameEngine');
const queries  = require('../../database/queries');

const QUESTION_COUNT_OPTIONS = [5, 10, 15, 20, 25, 30];
const TIME_LIMIT_OPTIONS     = [10, 15, 20, 30, 45, 60];
const POOL_CONFIRM_TIMEOUT   = 30_000;
const COUNTDOWN_SECONDS      = 5;


module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-start')
    .setDescription('ابدأ جلسة مسابقة ثقافية عربية')
    .setDMPermission(false),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const client  = interaction.client;

    // ── Permission check ────────────────────────────────────────────────────
    const settings = queries.getGuildSettings(guildId);

    if (!canManageSession(interaction, settings)) {
      return interaction.editReply({
        content: '⛔ ليس لديك صلاحية لبدء الجلسة.\nتحتاج إلى أحد أدوار الإدارة المعيّنة أو صلاحية Administrator.',
      });
    }

    if (!settings?.session_channel) {
      return interaction.editReply({
        content: '⚠️ لم يتم إعداد قناة الجلسة بعد.\nاستخدم `/trivia-setup` أولاً.',
      });
    }

    if (sm.hasSession(guildId)) {
      return interaction.editReply({
        content: '⚠️ هناك جلسة نشطة بالفعل في هذا السيرفر.\nاستخدم `/trivia-stop` لإنهائها أولاً.',
      });
    }

    // ── Pre-flight Channel & Permission Check ────────────────────────────────
    let targetChannel;
    try {
      targetChannel = await client.channels.fetch(settings.session_channel);
    } catch {}

    if (!targetChannel || !targetChannel.isTextBased()) {
      return interaction.editReply({
        content: '⛔ قناة الجلسة المحفوظة في الإعدادات لم تعد موجودة أو ليست قناة نصية.\nاستخدم `/trivia-setup` لإعادة تعيينها.',
      });
    }

    const botPerms = targetChannel.permissionsFor(client.user);
    if (!botPerms?.has(['SendMessages', 'EmbedLinks', 'ReadMessageHistory'])) {
      return interaction.editReply({
        content: `⛔ البوت يفتقد لصلاحيات أساسية في القناة <#${settings.session_channel}>.\nيرجى منحه صلاحيات: إرسال الرسائل، تضمين الروابط، وقراءة سجل الرسائل.`,
      });
    }

    // ── Resolve categories ──────────────────────────────────────────────────
    const enabledCats   = parseJson(settings.enabled_categories, []);
    const availableCats = config.categories.filter(c =>
      enabledCats.length === 0 || enabledCats.includes(c.id)
    );

    if (!availableCats.length) {
      return interaction.editReply({
        content: '⚠️ لا توجد فئات مفعّلة في هذا السيرفر.\nراجع إعدادات البوت عبر `/trivia-setup`.',
      });
    }

    // ── State ───────────────────────────────────────────────────────────────
    let selectedCount = null;
    let selectedTime  = null;
    // التحديد التلقائي إذا كانت هناك فئة واحدة فقط
    let selectedCats  = availableCats.length === 1 ? [availableCats[0].id] : null;
    let wizardDone    = false;

    // ── UI Builders ──────────────────────────────────────────────────────────
    const buildStartBtn = (disabled) => new ButtonBuilder()
      .setCustomId('start_confirm')
      .setLabel('ابدأ الجلسة 🚀')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled);

    const buildCancelBtn = () => new ButtonBuilder()
      .setCustomId('start_cancel')
      .setLabel('إلغاء')
      .setStyle(ButtonStyle.Secondary);

    const buildEmbed = () => {
      const allSelected = selectedCount !== null && selectedTime !== null && selectedCats !== null;
      
      // عرض أسماء الفئات المختارة
      const catDisplay = selectedCats 
        ? selectedCats.map(id => availableCats.find(c => c.id === id)?.nameAr || id).join('، ') 
        : '─── اختر من القائمة أعلاه';

      return new EmbedBuilder()
        .setTitle('🎮 إعداد جلسة المسابقة')
        .setDescription(
          `① **الأسئلة:** ${selectedCount !== null ? `**${selectedCount}** سؤالاً ✅` : '─── اختر من القائمة أعلاه'}\n` +
          `② **الوقت:** ${selectedTime  !== null ? `**${selectedTime}** ثانية ✅` : '─── اختر من القائمة أعلاه'}\n` +
          `③ **الفئات:** ${selectedCats  !== null ? `${catDisplay} ✅` : '─── اختر من القائمة أعلاه'}\n\n` +
          (allSelected
            ? '✅ **جاهز!** اضغط **ابدأ الجلسة** للمتابعة.'
            : '⬆️ اختر جميع الخيارات أعلاه لتفعيل زر البدء.')
        )
        .setColor(allSelected ? config.colors.success : config.colors.info)
        .setFooter({ text: `لديك ${Math.floor(config.wizardTimeoutMs / 60000)} دقائق للإعداد` });
    };

    const buildRows = () => {
      const allSelected = selectedCount !== null && selectedTime !== null && selectedCats !== null;

      const countMenu = new StringSelectMenuBuilder()
        .setCustomId('start_count')
        .setPlaceholder('① عدد الأسئلة')
        .addOptions(QUESTION_COUNT_OPTIONS.map(n => {
          const opt = new StringSelectMenuOptionBuilder()
            .setLabel(`${n} سؤالاً`)
            .setDescription(n <= 10 ? 'جلسة قصيرة' : n <= 20 ? 'جلسة متوسطة' : 'جلسة طويلة')
            .setValue(String(n));
          if (selectedCount === n) opt.setDefault(true);
          return opt;
        }));

      const timeMenu = new StringSelectMenuBuilder()
        .setCustomId('start_time')
        .setPlaceholder('② وقت كل سؤال (ثواني)')
        .addOptions(TIME_LIMIT_OPTIONS.map(n => {
          const opt = new StringSelectMenuOptionBuilder()
            .setLabel(`${n} ثانية`)
            .setDescription(n <= 15 ? 'سريع' : n <= 25 ? 'متوسط' : 'مريح')
            .setValue(String(n));
          if (selectedTime === n) opt.setDefault(true);
          return opt;
        }));

      const catMenu = new StringSelectMenuBuilder()
        .setCustomId('start_cats')
        .setPlaceholder(availableCats.length === 1 ? '③ الفئة (محددة تلقائياً)' : '③ الفئات (اختر واحدة أو أكثر)')
        .setMinValues(1)
        .setMaxValues(availableCats.length)
        .setDisabled(availableCats.length === 1) // تعطيل القائمة إذا كانت فئة واحدة
        .addOptions(availableCats.map(c => {
          const opt = new StringSelectMenuOptionBuilder()
            .setLabel(c.nameAr)
            .setValue(c.id);
          if (selectedCats?.includes(c.id)) opt.setDefault(true);
          return opt;
        }));

      return [
        new ActionRowBuilder().addComponents(countMenu),
        new ActionRowBuilder().addComponents(timeMenu),
        new ActionRowBuilder().addComponents(catMenu),
        new ActionRowBuilder().addComponents(buildStartBtn(!allSelected), buildCancelBtn()),
      ];
    };

    // ── Initial render ────────────────────────────────────────────────────────
    const msg = await interaction.editReply({
      embeds:     [buildEmbed()],
      components: buildRows(),
    });

    // ── Collector ─────────────────────────────────────────────────────────────
    const collector = msg.createMessageComponentCollector({
      // فلتر محسّن لتقليل العبء
      filter: i => i.user.id === interaction.user.id && 
                   ['start_count', 'start_time', 'start_cats', 'start_confirm', 'start_cancel'].includes(i.customId),
      time:   config.wizardTimeoutMs,
    });

    collector.on('collect', async i => {
      try {
        if (wizardDone) {
          return await i.deferUpdate().catch(() => {});
        }

        if (i.customId === 'start_cancel') {
          wizardDone = true;
          // منع النقر المزدوج عبر تعطيل الأزرار
          const disabledRows = buildRows().map(row => {
            row.components.forEach(comp => comp.setDisabled(true));
            return row;
          });
          await i.update({ content: '❌ تم إلغاء إعداد الجلسة.', embeds: [], components: disabledRows });
          collector.stop('cancelled');
          return;
        }

        if (i.customId === 'start_confirm') {
          if (!selectedCount || !selectedTime || !selectedCats) {
            return await i.deferUpdate().catch(() => {});
          }
          wizardDone = true;
          // منع النقر المزدوج عبر تعطيل الأزرار
          const disabledRows = buildRows().map(row => {
            row.components.forEach(comp => comp.setDisabled(true));
            return row;
          });
          await i.update({ content: '⏳ جاري التحضير...', embeds: [], components: disabledRows });
          collector.stop('confirmed');
          return;
        }

        // ── Select menus ────────────────────────────────────────────────────────
        if (i.customId === 'start_count') selectedCount = parseInt(i.values[0], 10);
        if (i.customId === 'start_time')  selectedTime  = parseInt(i.values[0], 10);
        if (i.customId === 'start_cats')  selectedCats  = i.values;

        await i.update({
          embeds:     [buildEmbed()],
          components: buildRows(),
        });
      } catch (err) {
        // التعامل مع حذف الرسالة (10008 Unknown Message)
        if (err.code === 10008) {
          wizardDone = true;
          collector.stop('message_deleted');
          return;
        }
        if (err.code === 40060 || err.code === 10062) return;
        console.error('[trivia-start collect error]', err);
      }
    });

    collector.on('end', async (_, reason) => {
      try {
        if (reason === 'time') {
          return await interaction.editReply({
            content:    '⏰ انتهت مهلة الإعداد. يرجى إعادة تشغيل `/trivia-start`.',
            embeds:     [],
            components: [],
          });
        }

        if (reason !== 'confirmed') return;

        await handleConfirmed({
          interaction, msg, guildId, client, settings,
          selectedCount, selectedTime, selectedCats,
        });
      } catch (err) {
        if (err.code === 10008 || err.code === 40060 || err.code === 10062) return;
        console.error('[trivia-start end error]', err);
      }
    });
  },
};


// ─── Confirm handler ─────────────────────────────────────────────────────────
async function handleConfirmed({ interaction, msg, guildId, client, settings, selectedCount, selectedTime, selectedCats }) {
  if (sm.hasSession(guildId)) {
    return interaction.editReply({
      content: '⚠️ بدأت جلسة أخرى في هذا السيرفر قبل تأكيدك.',
      embeds: [], components: [],
    }).catch(() => {});
  }

  let pool = qb.selectQuestions(selectedCats, selectedCount);

  if (pool.length === 0) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('⛔ لا توجد أسئلة متاحة')
        .setDescription('لا توجد أسئلة في الفئات المختارة. جرّب فئات أخرى.')
        .setColor(config.colors.error)],
      components: [],
    }).catch(() => {});
  }

  if (pool.length < selectedCount) {
    const confirmed = await askPoolConfirmation(interaction, msg, pool.length, selectedCount);
    if (!confirmed) return;
  }

  await launchSession({
    interaction, guildId, client, settings,
    questions:    pool.slice(0, selectedCount),
    timeLimitSec: selectedTime,
    categories:   selectedCats,
  });
}


// ─── Pool exhaustion confirmation ─────────────────────────────────────────────
async function askPoolConfirmation(interaction, msg, available, requested) {
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('⚠️ عدد الأسئلة المتاحة أقل من المطلوب')
      .setDescription(
        `طلبت **${requested}** سؤالاً، لكن المتاح **${available}** سؤال فقط.\n\n` +
        'هل تريد المتابعة بعدد الأسئلة المتاح؟'
      )
      .setColor(config.colors.warning)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pool_confirm').setLabel(`متابعة بـ ${available} سؤال`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pool_cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
    )],
  }).catch(() => {});

  return new Promise(resolve => {
    const col = msg.createMessageComponentCollector({
      filter: i =>
        i.user.id === interaction.user.id &&
        ['pool_confirm', 'pool_cancel'].includes(i.customId),
      time: POOL_CONFIRM_TIMEOUT,
      max:  1,
    });

    col.on('collect', async i => {
      try {
        if (i.customId === 'pool_cancel') {
          await i.update({
            content: '❌ تم إلغاء الجلسة.',
            embeds: [],
            components: [],
          });
          return resolve(false);
        }

        await i.update({
          content: '⏳ جاري التحضير...',
          embeds: [],
          components: [],
        });
        return resolve(true);
      } catch (err) {
        if (err.code === 40060 || err.code === 10062 || err.code === 10008) {
          return resolve(i.customId === 'pool_confirm');
        }
        console.error('[askPoolConfirmation collect]', err);
        return resolve(false);
      }
    });

    col.on('end', async (_, reason) => {
      if (reason === 'time') {
        try {
          await interaction.editReply({ content: '⏰ انتهت المهلة.', embeds: [], components: [] });
        } catch {}
        resolve(false);
      }
    });
  });
}


// ─── Session launcher ─────────────────────────────────────────────────────────
async function launchSession({ interaction, guildId, client, settings, questions, timeLimitSec, categories }) {
  const invalidIds     = await validateQuestionImages(questions);
  const validQuestions = applyImageValidation(questions, invalidIds);

  if (!validQuestions.length) {
    return interaction.editReply({
      content: '⛔ لا توجد أسئلة صالحة بعد التحقق من الصور.',
      embeds: [], components: [],
    }).catch(() => {});
  }

  const created = sm.createSession(guildId, {
    hostId:        interaction.user.id,
    channelId:     settings.session_channel,
    categories,
    questionCount: validQuestions.length,
    timeLimitSec,
    questions:     validQuestions,
  });

  if (!created) {
    return interaction.editReply({
      content: '⚠️ لا يمكن بدء الجلسة — هناك جلسة نشطة بالفعل.',
      embeds: [], components: [],
    }).catch(() => {});
  }

  let channel;
  try {
    channel = await client.channels.fetch(settings.session_channel);
    if (!channel?.isTextBased()) throw new Error('ليست قناة نصية');
  } catch {
    sm.deleteSession(guildId);
    return interaction.editReply({
      content: '⛔ تعذّر الوصول إلى قناة الجلسة. تأكد من صلاحيات البوت.',
      embeds: [], components: [],
    }).catch(() => {});
  }

  await interaction.editReply({
    content:
      `✅ **ستبدأ الجلسة في <#${settings.session_channel}> خلال ${COUNTDOWN_SECONDS} ثوانٍ!**\n` +
      `📋 ${validQuestions.length} سؤال | ⏱️ ${timeLimitSec} ثانية لكل سؤال`,
    embeds:     [],
    components: [],
  }).catch(() => {});

  let countdownMsg = null;
  try {
    countdownMsg = await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🎮 جلسة مسابقة على وشك البدء!')
        .setDescription(
          `**عدد الأسئلة:** ${validQuestions.length}\n` +
          `**وقت الإجابة:** ${timeLimitSec} ثانية لكل سؤال\n\n` +
          `⏳ **تبدأ خلال ${COUNTDOWN_SECONDS} ثوانٍ — استعدوا!**`
        )
        .setColor(config.colors.warning)
        .setTimestamp()],
    });
  } catch {
    // نكمل بدون countdown
  }

  await sleep(COUNTDOWN_SECONDS * 1000);

  if (countdownMsg) {
    await countdownMsg.delete().catch(() => {});
  }

  const session = sm.getSession(guildId);
  if (!session) return;

  await startSession(client, session, channel);
}


// ─── Helpers ──────────────────────────────────────────────────────────────────
function canManageSession(interaction, settings) {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const roles = parseJson(settings?.manager_roles, []);
  if (!roles.length) return false;
  return interaction.member.roles.cache.some(r => roles.includes(r.id));
}

function parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

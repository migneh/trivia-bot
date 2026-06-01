'use strict';
/**
 * events/guildCreate.js
 *
 * Fires when the bot joins a new guild (server).
 *
 * ─── Actions ─────────────────────────────────────────────────────────────────
 *
 *  1. Log the join to console.
 *  2. Register slash commands for the new guild immediately.
 *     Per-guild registration is instant (vs. global = up to 1 hour).
 *  3. Optionally send a welcome message to the first accessible text channel.
 *     (Disabled by default — uncomment the block below to enable.)
 *
 * ─── Why register here AND in ready.js? ──────────────────────────────────────
 *
 *   ready.js handles guilds the bot was already in at startup.
 *   guildCreate handles guilds the bot joins WHILE running.
 *   Both are needed to cover all cases.
 *
 * ─── Error handling ──────────────────────────────────────────────────────────
 *
 *   Registration failure is logged but not fatal.
 *   The bot can still receive messages and answer prefix commands.
 *   Slash commands will just not show up until the next restart or
 *   until the bot is re-invited with correct permissions.
 *
 * ─── Required OAuth2 scope ───────────────────────────────────────────────────
 *
 *   The bot invite link must include the `applications.commands` scope
 *   in addition to `bot` for slash command registration to succeed.
 *   Invite URL: https://discord.com/api/oauth2/authorize
 *     ?client_id=YOUR_CLIENT_ID
 *     &permissions=YOUR_PERMISSIONS
 *     &scope=bot%20applications.commands
 */

const { Events, REST, Routes } = require('discord.js');
const fs     = require('node:fs');
const path   = require('node:path');
const config = require('../config.json');
const { logToOwner } = require('../utils/gameEngine');


// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  name: Events.GuildCreate,
  once: false,

  /**
   * @param {import('discord.js').Guild} guild
   */
  async execute(guild) {
    console.log(
      `[GuildCreate] Joined: "${guild.name}" (${guild.id}) — ` +
      `${guild.memberCount} members`
    );

    // ── Register slash commands for this guild ─────────────────────────────────
    await registerCommandsForGuild(guild);

    // ── Notify owner log channel ───────────────────────────────────────────────
    await logToOwner(
      guild.client,
      `✅ **Bot joined a new guild:**\n` +
      `**Name:** ${guild.name}\n` +
      `**ID:** \`${guild.id}\`\n` +
      `**Members:** ${guild.memberCount}`
    );

    // ── Optional: send welcome message ────────────────────────────────────────
    // Uncomment to send an Arabic welcome message to the first accessible channel.
    //
    // await sendWelcomeMessage(guild);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// SLASH COMMAND REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register all slash commands for a single guild.
 *
 * @param {import('discord.js').Guild} guild
 */
async function registerCommandsForGuild(guild) {
  const commands = loadCommandData();

  if (commands.length === 0) {
    console.warn(`[GuildCreate] No commands to register for guild ${guild.id}.`);
    return;
  }

  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);

    await rest.put(
      Routes.applicationGuildCommands(config.clientId, guild.id),
      { body: commands }
    );

    console.log(
      `[GuildCreate] Registered ${commands.length} slash command(s) for ` +
      `guild ${guild.id} (${guild.name}).`
    );

  } catch (err) {
    // Common causes:
    //   50001 — Missing Access (bot lacks applications.commands scope)
    //   30034 — Max application commands reached
    console.error(
      `[GuildCreate] Failed to register commands for guild ${guild.id}:`,
      err.message
    );
  }
}

/**
 * Load all slash command JSON definitions from commands/slash/.
 * Mirrors the same logic used in ready.js.
 *
 * @returns {object[]}
 */
function loadCommandData() {
  const slashDir = path.join(__dirname, '..', 'commands', 'slash');

  if (!fs.existsSync(slashDir)) return [];

  const commands = [];

  for (const file of fs.readdirSync(slashDir).filter(f => f.endsWith('.js'))) {
    try {
      const cmd = require(path.join(slashDir, file));
      if (cmd?.data && typeof cmd?.execute === 'function') {
        commands.push(cmd.data.toJSON());
      }
    } catch (err) {
      console.error(`[GuildCreate] Failed to load command file ${file}:`, err.message);
    }
  }

  return commands;
}


// ═══════════════════════════════════════════════════════════════════════════════
// WELCOME MESSAGE  (optional — disabled by default)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send an Arabic welcome message to the first text channel the bot
 * can send messages in.
 *
 * To enable: uncomment the call in execute() above.
 *
 * @param {import('discord.js').Guild} guild
 */
// async function sendWelcomeMessage(guild) {
//   const { EmbedBuilder } = require('discord.js');
//
//   // Find the first text channel where the bot has Send Messages permission
//   const channel = guild.channels.cache
//     .filter(ch =>
//       ch.isTextBased() &&
//       ch.permissionsFor(guild.members.me)?.has('SendMessages')
//     )
//     .sort((a, b) => a.position - b.position)
//     .first();
//
//   if (!channel) return;
//
//   const embed = new EmbedBuilder()
//     .setTitle('🎮 مرحباً! أنا بوت المسابقة العربية')
//     .setDescription(
//       '**شكراً لإضافتي إلى سيرفركم!**\n\n' +
//       '📋 **للبدء:** استخدم `/trivia-setup` لإعداد البوت\n' +
//       '🎯 **لبدء جلسة:** استخدم `/trivia-start`\n' +
//       '❓ **للمساعدة:** استخدم `/trivia-help`\n\n' +
//       '*يمكن أيضاً استخدام الأوامر النصية: `!trivia help`*'
//     )
//     .setColor(config.colors.success)
//     .setFooter({ text: 'جميع الأوامر متاحة بالعربية الكاملة' })
//     .setTimestamp();
//
//   await channel.send({ embeds: [embed] }).catch(() => {});
// }

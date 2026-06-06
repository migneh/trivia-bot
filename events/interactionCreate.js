'use strict';
/**
 * events/interactionCreate.js
 *
 * Central dispatcher for all Discord interactions received by the bot.
 *
 * ─── Interaction types handled ────────────────────────────────────────────────
 *
 *   ChatInputCommand  → slash commands (/trivia-start, /trivia-stop, etc.)
 *   Button            → game answer buttons (trivia_answer:N)
 *                       and wizard/confirmation buttons.
 *   SelectMenu        → wizard dropdowns (start_count, start_time, etc.)
 *
 * ─── Collector Handled Interactions ───────────────────────────────────────────
 *
 *   IMPORTANT: Buttons and Select Menus used in wizards or games are handled 
 *   by local `MessageComponentCollector`s inside their respective command files.
 *   We DO NOT call `deferUpdate()` here for those components, otherwise the 
 *   local collectors will throw a 40060 (Interaction already acknowledged) error.
 *   We simply `return` and let the collectors do their job.
 */

const { Events } = require('discord.js');

// ─── Button customId prefixes managed by inline collectors ────────────────────
const GAME_BUTTON_PREFIX   = 'trivia_answer:';
const WIZARD_BUTTON_PREFIXES = [
  'setup_', 'sched_', 'start_', 'stop_', 'pool_',
  'help_prev', 'help_next',
];


// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  name: Events.InteractionCreate,
  once: false,

  /**
   * @param {import('discord.js').Interaction} interaction
   */
  async execute(interaction) {

    // ── ChatInputCommand (slash commands) ──────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    // ── Button interactions ────────────────────────────────────────────────────
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    // ── StringSelectMenu interactions ──────────────────────────────────────────
    if (interaction.isStringSelectMenu()    ||
        interaction.isChannelSelectMenu()   ||
        interaction.isRoleSelectMenu()      ||
        interaction.isUserSelectMenu()      ||
        interaction.isMentionableSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
      return;
    }

    // All other interaction types (modals, autocomplete, etc.)
    // are not used by this bot — silently ignored.
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// SLASH COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Route a slash command interaction to its registered command handler.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleSlashCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);

  // Unknown command — not registered or file missing
  if (!command) {
    console.warn(`[InteractionCreate] Unknown slash command: /${interaction.commandName}`);
    await safeReply(interaction, {
      content:   `⛔ الأمر \`/${interaction.commandName}\` غير معروف.`,
      ephemeral: true,
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[InteractionCreate] Error in /${interaction.commandName}:`, err);
    await safeReplyError(interaction,
      `حدث خطأ أثناء تنفيذ الأمر \`/${interaction.commandName}\`.`
    );
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// BUTTON INTERACTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle button interactions.
 * 
 * If the button belongs to a game or a wizard, we DO NOT acknowledge it here.
 * We just return and let the inline MessageComponentCollector handle it.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  // ── Game answer button ───────────────────────────────────────
  if (customId.startsWith(GAME_BUTTON_PREFIX)) {
    // Handled by inline collectors in gameEngine.collectVotes()
    return; 
  }

  // ── Wizard / confirmation button ───────────────────────────────
  const isWizardButton = WIZARD_BUTTON_PREFIXES.some(prefix =>
    customId.startsWith(prefix)
  );

  if (isWizardButton) {
    // Handled by inline collectors in command files (e.g., trivia-start.js)
    return; 
  }

  // ── Unknown button ────────────────────────────────────────────
  // Could be from a third-party integration or a future feature.
  // Acknowledge silently to prevent "interaction failed" in Discord.
  console.warn(`[InteractionCreate] Unknown button customId: "${customId}"`);
  try {
    await interaction.deferUpdate();
  } catch {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// SELECT MENU INTERACTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle select menu interactions.
 * 
 * All select menus in this bot are managed by inline collectors.
 * We DO NOT deferUpdate here, otherwise the collector's i.update() will fail.
 *
 * @param {import('discord.js').AnySelectMenuInteraction} interaction
 */
async function handleSelectMenuInteraction(interaction) {
  // Let the local collectors (like in trivia-start.js) handle the update
  return;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAFE REPLY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reply to an interaction safely, handling the case where it was
 * already deferred or replied to.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {object} options - reply options
 */
async function safeReply(interaction, options) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(options);
    } else {
      await interaction.reply(options);
    }
  } catch (err) {
    // Interaction expired (15-minute window) or already handled
    if (err.code !== 10062) { // 10062 = Unknown Interaction
      console.error('[InteractionCreate] safeReply failed:', err.message);
    }
  }
}

/**
 * Send an Arabic error message as an ephemeral reply.
 * Used for unexpected errors in command handlers.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} detail - Arabic error detail text
 */
async function safeReplyError(interaction, detail) {
  const content = `⛔ **خطأ:** ${detail}\nإذا استمر الخطأ، يرجى إبلاغ الإدارة.`;
  await safeReply(interaction, { content, ephemeral: true });
}

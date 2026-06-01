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
 *                       and wizard/confirmation buttons (handled by
 *                       inline collectors — NOT re-routed here)
 *
 * ─── Slash command routing ────────────────────────────────────────────────────
 *
 *   Commands are stored in client.commands (Collection) by name.
 *   Each command file exports { data, execute }.
 *   If the command is not found, the interaction is replied to with
 *   an Arabic error message (ephemeral).
 *
 * ─── Button interaction routing ───────────────────────────────────────────────
 *
 *   Game answer buttons (customId = "trivia_answer:N") are collected
 *   by inline MessageComponentCollectors in gameEngine.collectVotes().
 *   They arrive here ONLY if no collector is active (e.g. time expired
 *   but Discord hasn't acknowledged it yet, or collector was cleaned up).
 *
 *   In that case: defer + reply "وقت الإجابة انتهى" (ephemeral).
 *
 *   Wizard buttons (setup_*, sched_*, start_*, stop_*, pool_*, help_*)
 *   are also collector-handled. If they arrive here without an active
 *   collector, we defer and ignore silently — the wizard already timed out.
 *
 * ─── Error handling ───────────────────────────────────────────────────────────
 *
 *   Every handler is wrapped in try-catch.
 *   Errors attempt an ephemeral reply if the interaction hasn't been
 *   responded to yet. If even that fails, the error is only logged.
 *
 * ─── deferReply / deferUpdate ────────────────────────────────────────────────
 *
 *   Each slash command calls deferReply() as its FIRST async operation.
 *   This handler does NOT call defer — commands own their own timing.
 *   For stale button interactions caught here, we defer before replying.
 */

const { Events, InteractionType, ComponentType } = require('discord.js');
const config = require('../config.json');

// ─── Button customId prefixes managed by inline collectors ────────────────────
// Interactions with these prefixes are collector-handled.
// If they arrive here, the collector is gone — handle gracefully.
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
 * Handle button interactions that reach this global handler.
 *
 * Game buttons (trivia_answer:N):
 *   If a collector is active for this message, the collector handles it
 *   and this handler never sees it. If we DO see it here, the time has
 *   expired — reply with "وقت الإجابة انتهى".
 *
 * Wizard / confirmation buttons:
 *   Handled by inline collectors in command files.
 *   If they arrive here, the collector already timed out or was stopped.
 *   Defer + acknowledge silently.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  // ── Game answer button (time expired) ───────────────────────────────────────
  if (customId.startsWith(GAME_BUTTON_PREFIX)) {
    try {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({
        content: '⏰ **وقت الإجابة انتهى** — لم يتم تسجيل إجابتك.',
      });
    } catch {
      // Interaction already acknowledged or expired — ignore
    }
    return;
  }

  // ── Wizard / confirmation button (collector timed out) ───────────────────────
  const isWizardButton = WIZARD_BUTTON_PREFIXES.some(prefix =>
    customId.startsWith(prefix)
  );

  if (isWizardButton) {
    try {
      // Acknowledge to dismiss the "interaction failed" state in Discord
      await interaction.deferUpdate();
    } catch {
      // Already acknowledged or expired — ignore
    }
    return;
  }

  // ── Unknown button ────────────────────────────────────────────────────────────
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
 * Handle select menu interactions that reach this global handler.
 * These are all handled by inline collectors — if they arrive here,
 * the collector has already ended (timed out or stopped).
 * Acknowledge silently.
 *
 * @param {import('discord.js').AnySelectMenuInteraction} interaction
 */
async function handleSelectMenuInteraction(interaction) {
  try {
    await interaction.deferUpdate();
  } catch {
    // Already acknowledged or expired — ignore
  }
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

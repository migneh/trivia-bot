'use strict';
/**
 * commands/prefix/router.js
 *
 * Routes prefix commands (!trivia <subcommand>) to the same underlying
 * logic used by slash commands — no duplicate code paths.
 *
 * ─── Strategy ────────────────────────────────────────────────────────────────
 *
 *   Each prefix subcommand delegates to its slash command counterpart
 *   via a lightweight "interaction shim" object that mimics the Discord.js
 *   ChatInputCommandInteraction interface.
 *
 *   The shim handles:
 *     • deferReply()  — sends the first message to the channel
 *     • editReply()   — edits or sends subsequent messages
 *     • followUp()    — sends additional messages
 *     • options       — typed getters that read from parsed args/mentions
 *
 *   This means every bug fix and feature in a slash command automatically
 *   applies to the prefix equivalent — zero maintenance overhead.
 *
 * ─── Subcommand routing table ────────────────────────────────────────────────
 *
 *   start        → trivia-start.js  execute()
 *   stop         → trivia-stop.js   execute()
 *   skip         → trivia-skip.js   execute()
 *   leaderboard  → sendLeaderboard() (direct — no wizard needed)
 *   profile      → trivia-profile.js execute()
 *   setup        → runSetupWizard() (direct export)
 *   schedule     → runScheduleWizard() (direct export)
 *   help         → sendHelp() (direct export)
 *   stats        → sendStats() (direct export)
 *
 * ─── Unknown subcommand ───────────────────────────────────────────────────────
 *
 *   Per spec: silently ignore. No reply, no error.
 *   Example: "!trivia xyz" → nothing happens.
 *
 * ─── Bare prefix ─────────────────────────────────────────────────────────────
 *
 *   "!trivia" with no subcommand → show help (page 1).
 *   Handled in messageCreate.js before reaching this router.
 *
 * ─── Shim limitations ────────────────────────────────────────────────────────
 *
 *   The shim uses channel.send() / message.edit() instead of the
 *   interaction webhook. This means:
 *     • No ephemeral replies — all replies are visible in the channel.
 *     • No interaction token expiry — messages can be edited anytime.
 *     • Wizards that use createMessageComponentCollector() on the sent
 *       message work correctly — the shim returns the sent Message.
 *     • fetchReply: true is handled automatically (shim always returns msg).
 */

const { PermissionFlagsBits } = require('discord.js');

// ─── Slash command modules ────────────────────────────────────────────────────
const triviaStart      = require('../slash/trivia-start');
const triviaStop       = require('../slash/trivia-stop');
const triviaSkip       = require('../slash/trivia-skip');
const triviaLeaderboard = require('../slash/trivia-leaderboard');
const triviaProfile    = require('../slash/trivia-profile');
const triviaSetup      = require('../slash/trivia-setup');
const triviaSchedule   = require('../slash/trivia-schedule');
const triviaHelp       = require('../slash/trivia-help');
const triviaStats      = require('../slash/trivia-stats');

// ─── Known subcommands ────────────────────────────────────────────────────────
// Used for silent-ignore check — anything not in this set is ignored.
const KNOWN_SUBCOMMANDS = new Set([
  'start', 'stop', 'skip',
  'leaderboard', 'lb',          // 'lb' as alias
  'profile', 'p',               // 'p' as alias
  'setup', 'schedule',
  'help', 'h',                  // 'h' as alias
  'stats',
]);


// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTION SHIM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a lightweight object that mimics ChatInputCommandInteraction.
 * Allows slash command execute() functions to work with prefix commands
 * without any modification.
 *
 * @param {import('discord.js').Message} message - the original prefix command message
 * @param {object} [opts]
 * @param {Object.<string, string|null>} [opts.strings]  - named string options
 * @param {Object.<string, import('discord.js').User|null>} [opts.users] - named user options
 * @returns {object} shim interaction object
 */
function createShim(message, opts = {}) {
  const { strings = {}, users = {} } = opts;

  /** @type {import('discord.js').Message|null} */
  let sentMessage = null;
  let isDeferred  = false;
  let isReplied   = false;

  const shim = {
    // ── Identity ──────────────────────────────────────────────────────────────
    guildId:   message.guildId,
    channelId: message.channelId,
    user:      message.author,
    member:    message.member,
    client:    message.client,
    channel:   message.channel,
    guild:     message.guild,

    // ── State flags (mirrors ChatInputCommandInteraction) ─────────────────────
    get deferred() { return isDeferred; },
    get replied()  { return isReplied;  },

    // ── Options API ───────────────────────────────────────────────────────────
    options: {
      /**
       * Get a string option by name.
       * @param {string} name
       * @returns {string|null}
       */
      getString(name) {
        return strings[name] ?? null;
      },

      /**
       * Get a user option by name.
       * @param {string} name
       * @returns {import('discord.js').User|null}
       */
      getUser(name) {
        return users[name] ?? null;
      },

      /**
       * Get a boolean option (not used by current commands — stub).
       * @returns {boolean|null}
       */
      getBoolean(_name) {
        return null;
      },

      /**
       * Get an integer option (not used by current commands — stub).
       * @returns {number|null}
       */
      getInteger(_name) {
        return null;
      },
    },

    // ── Reply methods ─────────────────────────────────────────────────────────

    /**
     * Simulates deferReply().
     * For prefix commands, we do nothing visually (no "thinking..." state).
     * Sets the deferred flag so editReply() knows to send rather than edit.
     *
     * @param {object} [_options] - ignored (ephemeral has no meaning for prefix)
     */
    async deferReply(_options) {
      isDeferred = true;
    },

    /**
     * Simulates editReply().
     * First call → sends a new message to the channel.
     * Subsequent calls → edits the previously sent message.
     *
     * Always returns the sent/edited Message object (equivalent to fetchReply: true).
     *
     * @param {string|object} data
     * @returns {Promise<import('discord.js').Message>}
     */
    async editReply(data) {
      const payload = normalisePayload(data);

      if (!sentMessage) {
        // First reply — send to channel
        sentMessage = await message.channel.send(payload);
        isReplied   = true;
      } else {
        // Subsequent reply — edit the existing message
        sentMessage = await sentMessage.edit(payload);
      }

      return sentMessage;
    },

    /**
     * Simulates reply() — same as editReply() for prefix shim.
     *
     * @param {string|object} data
     * @returns {Promise<import('discord.js').Message>}
     */
    async reply(data) {
      return shim.editReply(data);
    },

    /**
     * Simulates followUp() — always sends a new message.
     *
     * @param {string|object} data
     * @returns {Promise<import('discord.js').Message>}
     */
    async followUp(data) {
      const payload = normalisePayload(data);
      return message.channel.send(payload);
    },

    /**
     * Simulates fetchReply() — returns the last sent message.
     * Some command patterns call this after deferReply().
     *
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async fetchReply() {
      return sentMessage;
    },
  };

  return shim;
}

/**
 * Normalise a reply payload to a plain object safe for channel.send().
 * Strips ephemeral and fetchReply flags that don't apply to text messages.
 *
 * @param {string|object} data
 * @returns {object}
 */
function normalisePayload(data) {
  if (typeof data === 'string') {
    return { content: data };
  }

  // eslint-disable-next-line no-unused-vars
  const { ephemeral, fetchReply, ...rest } = data;

  // content must be a string or undefined — never null (Discord.js rejects null)
  if (rest.content === null) delete rest.content;

  return rest;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the message author can manage trivia sessions.
 * Mirrors the same logic used in slash commands.
 *
 * @param {import('discord.js').Message} message
 * @param {object|null} settings - guild settings from DB
 * @returns {boolean}
 */
function canManageSession(message, settings) {
  const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
  if (isAdmin) return true;

  let managerRoles = [];
  try { managerRoles = JSON.parse(settings?.manager_roles ?? '[]'); } catch {}

  if (managerRoles.length === 0) return false;
  return message.member.roles.cache.some(r => managerRoles.includes(r.id));
}

/**
 * Check if the message author has Administrator permission.
 *
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
function isAdmin(message) {
  return message.member.permissions.has(PermissionFlagsBits.Administrator);
}


// ═══════════════════════════════════════════════════════════════════════════════
// ARGUMENT PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse mentions from a message.
 * Returns the first mentioned user (if any).
 *
 * @param {import('discord.js').Message} message
 * @returns {import('discord.js').User|null}
 */
function parseFirstMention(message) {
  return message.mentions.users.first() ?? null;
}

/**
 * Normalise a subcommand string to its canonical form.
 * Handles aliases (lb → leaderboard, p → profile, h → help).
 *
 * @param {string} sub
 * @returns {string}
 */
function normaliseSubcommand(sub) {
  const lower = sub.toLowerCase();
  const ALIASES = {
    lb:    'leaderboard',
    p:     'profile',
    h:     'help',
  };
  return ALIASES[lower] ?? lower;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle a parsed prefix command.
 * Called by events/messageCreate.js after extracting the subcommand and args.
 *
 * @param {import('discord.js').Message} message
 * @param {string} rawSubcommand   - e.g. "start", "leaderboard", "lb"
 * @param {string[]} args          - remaining words after the subcommand
 */
async function handlePrefixCommand(message, rawSubcommand, args) {
  // ── Guard: must be in a guild ──────────────────────────────────────────────
  if (!message.guild || !message.member) return;

  // ── Normalise subcommand ───────────────────────────────────────────────────
  const sub = normaliseSubcommand(rawSubcommand);

  // ── Silent-ignore unknown subcommands ─────────────────────────────────────
  if (!KNOWN_SUBCOMMANDS.has(sub) && !KNOWN_SUBCOMMANDS.has(rawSubcommand.toLowerCase())) {
    return; // no reply, no error
  }

  // ── Lazy-load guild settings (needed for permission checks) ───────────────
  const { getGuildSettings } = require('../../database/queries');
  const settings = getGuildSettings(message.guildId);

  // ── Route to handler ───────────────────────────────────────────────────────
  try {
    switch (sub) {

      // ── start ──────────────────────────────────────────────────────────────
      case 'start': {
        if (!canManageSession(message, settings)) {
          await message.reply('⛔ ليس لديك صلاحية لبدء الجلسة.');
          return;
        }
        const shim = createShim(message);
        await triviaStart.execute(shim);
        break;
      }

      // ── stop ───────────────────────────────────────────────────────────────
      case 'stop': {
        if (!canManageSession(message, settings)) {
          await message.reply('⛔ ليس لديك صلاحية لإيقاف الجلسة.');
          return;
        }
        const shim = createShim(message);
        await triviaStop.execute(shim);
        break;
      }

      // ── skip ───────────────────────────────────────────────────────────────
      case 'skip': {
        if (!canManageSession(message, settings)) {
          await message.reply('⛔ ليس لديك صلاحية لتخطي السؤال.');
          return;
        }
        const shim = createShim(message);
        await triviaSkip.execute(shim);
        break;
      }

      // ── leaderboard ────────────────────────────────────────────────────────
      case 'leaderboard': {
        // args[0] may be 'day', 'week', or 'month'
        const VALID_RANGES = new Set(['day', 'week', 'month']);
        const range = VALID_RANGES.has(args[0]?.toLowerCase())
          ? args[0].toLowerCase()
          : 'month';

        const shim = createShim(message, { strings: { range } });
        await shim.deferReply();
        await triviaLeaderboard.sendLeaderboard(shim, message.guildId, range);
        break;
      }

      // ── profile ────────────────────────────────────────────────────────────
      case 'profile': {
        const targetUser = parseFirstMention(message);
        const shim = createShim(message, {
          users: { user: targetUser },
        });
        await triviaProfile.execute(shim);
        break;
      }

      // ── setup ──────────────────────────────────────────────────────────────
      case 'setup': {
        if (!isAdmin(message)) {
          await message.reply('⛔ يتطلب هذا الأمر صلاحية **Administrator**.');
          return;
        }
        const shim = createShim(message);
        await shim.deferReply();
        await triviaSetup.runSetupWizard(shim);
        break;
      }

      // ── schedule ───────────────────────────────────────────────────────────
      case 'schedule': {
        if (!isAdmin(message)) {
          await message.reply('⛔ يتطلب هذا الأمر صلاحية **Administrator**.');
          return;
        }
        const shim = createShim(message);
        await shim.deferReply();
        await triviaSchedule.runScheduleWizard(shim);
        break;
      }

      // ── help ───────────────────────────────────────────────────────────────
      case 'help': {
        // Optional: args[0] could be a page number (1-based)
        const pageArg  = parseInt(args[0], 10);
        const startPage = !isNaN(pageArg) && pageArg >= 1
          ? Math.min(pageArg - 1, 5) // 0-based, max 5 (6 pages)
          : 0;

        const shim = createShim(message);
        await shim.deferReply();
        await triviaHelp.sendHelp(shim, startPage);
        break;
      }

      // ── stats ──────────────────────────────────────────────────────────────
      case 'stats': {
        const shim = createShim(message);
        await triviaStats.sendStats(shim, message.guildId);
        break;
      }

      // ── Default (should never reach here due to KNOWN_SUBCOMMANDS guard) ──
      default:
        break;
    }
  } catch (err) {
    console.error(`[PrefixRouter][${sub}]`, err);
    // Attempt to notify the user — fail silently if that also errors
    await message.channel.send(
      '⛔ حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مجدداً.'
    ).catch(() => {});
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = { handlePrefixCommand };

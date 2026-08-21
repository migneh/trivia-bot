'use strict';
/**
 * commands/prefix/router.js
 *
 * Routes prefix commands (!trivia <subcommand>) to the same underlying
 * logic used by slash commands.
 */

const { PermissionFlagsBits } = require('discord.js');

// ─── Slash command modules ────────────────────────────────────────────────────
const triviaStart       = require('../slash/trivia-start');
const triviaStop        = require('../slash/trivia-stop');
const triviaSkip        = require('../slash/trivia-skip');
const triviaLeaderboard = require('../slash/trivia-leaderboard');
const triviaProfile     = require('../slash/trivia-profile');
const triviaSetup       = require('../slash/trivia-setup');
const triviaSchedule    = require('../slash/trivia-schedule');
const triviaHelp        = require('../slash/trivia-help');
const triviaStats       = require('../slash/trivia-stats');
const triviaDuel        = require('../slash/trivia-duel');
const triviaSurvival    = require('../slash/trivia-survival');
const triviaTeams       = require('../slash/trivia-teams');
const triviaDaily       = require('../slash/trivia-daily');
const triviaShop        = require('../slash/trivia-shop');
const triviaInventory   = require('../slash/trivia-inventory');
const triviaEconomy     = require('../slash/trivia-economy');
const triviaClan        = require('../slash/trivia-clan');
const triviaQuest       = require('../slash/trivia-quest');
const triviaSeason      = require('../slash/trivia-season');
const triviaCustom      = require('../slash/trivia-custom');
const triviaDashboard   = require('../slash/trivia-dashboard');

// ─── Known subcommands ────────────────────────────────────────────────────────
const KNOWN_SUBCOMMANDS = new Set([
  'start', 'stop', 'skip',
  'leaderboard', 'lb',
  'profile', 'p',
  'setup', 'schedule',
  'help', 'h',
  'stats',
  'duel', 'd',
  'survival', 'surv',
  'teams', 'team',
  'daily',
  'shop',
  'inventory', 'inv', 'bag',
  'economy', 'coins', 'bal', 'balance',
  'clan', 'clans',
  'quest', 'quests',
  'season',
  'custom',
  'dashboard', 'web',
]);

function createShim(message, opts = {}) {
  const { strings = {}, users = {}, integers = {}, subcommands = [] } = opts;

  let sentMessage = null;
  let isDeferred  = false;
  let isReplied   = false;

  const shim = {
    guildId:   message.guildId,
    channelId: message.channelId,
    user:      message.author,
    member:    message.member,
    client:    message.client,
    channel:   message.channel,
    guild:     message.guild,

    get deferred() { return isDeferred; },
    get replied()  { return isReplied;  },

    options: {
      getString(name) {
        return strings[name] ?? null;
      },
      getUser(name) {
        return users[name] ?? null;
      },
      getBoolean(_name) {
        return null;
      },
      getInteger(name) {
        return integers[name] ?? null;
      },
      getSubcommand() {
        return subcommands[0] ?? null;
      },
    },

    async deferReply(_options) {
      isDeferred = true;
    },

    async editReply(data) {
      const payload = normalisePayload(data);

      if (!sentMessage) {
        sentMessage = await message.channel.send(payload);
        isReplied   = true;
      } else {
        sentMessage = await sentMessage.edit(payload);
      }

      return sentMessage;
    },

    async reply(data) {
      return shim.editReply(data);
    },

    async followUp(data) {
      const payload = normalisePayload(data);
      return message.channel.send(payload);
    },

    async fetchReply() {
      return sentMessage;
    },
  };

  return shim;
}

function normalisePayload(data) {
  if (typeof data === 'string') {
    return { content: data };
  }

  // eslint-disable-next-line no-unused-vars
  const { ephemeral, fetchReply, ...rest } = data;
  if (rest.content === null) delete rest.content;
  return rest;
}

function canManageSession(message, settings) {
  const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
  if (isAdmin) return true;

  let managerRoles = [];
  try { managerRoles = JSON.parse(settings?.manager_roles ?? '[]'); } catch {}

  if (managerRoles.length === 0) return false;
  return message.member.roles.cache.some(r => managerRoles.includes(r.id));
}

function isAdmin(message) {
  return message.member.permissions.has(PermissionFlagsBits.Administrator);
}

function parseFirstMention(message) {
  return message.mentions.users.first() ?? null;
}

function normaliseSubcommand(sub) {
  const lower = sub.toLowerCase();
  const ALIASES = {
    lb:        'leaderboard',
    p:         'profile',
    h:         'help',
    d:         'duel',
    surv:      'survival',
    team:      'teams',
    inv:       'inventory',
    bag:       'inventory',
    bal:       'economy',
    balance:   'economy',
    coins:     'economy',
    clans:     'clan',
    quests:    'quest',
    web:       'dashboard',
  };
  return ALIASES[lower] ?? lower;
}

async function handlePrefixCommand(message, rawSubcommand, args) {
  if (!message.guild || !message.member) return;

  const sub = normaliseSubcommand(rawSubcommand);

  if (!KNOWN_SUBCOMMANDS.has(sub) && !KNOWN_SUBCOMMANDS.has(rawSubcommand.toLowerCase())) {
    return;
  }

  const { getGuildSettings } = require('../../database/queries');
  const settings = getGuildSettings(message.guildId);

  try {
    switch (sub) {
      case 'start': {
        if (!canManageSession(message, settings)) {
          await message.reply('⛔ ليس لديك صلاحية لبدء الجلسة.');
          return;
        }
        const shim = createShim(message);
        await triviaStart.execute(shim);
        break;
      }

      case 'stop': {
        if (!canManageSession(message, settings)) {
          await message.reply('⛔ ليس لديك صلاحية لإيقاف الجلسة.');
          return;
        }
        const shim = createShim(message);
        await triviaStop.execute(shim);
        break;
      }

      case 'skip': {
        if (!canManageSession(message, settings)) {
          await message.reply('⛔ ليس لديك صلاحية لتخطي السؤال.');
          return;
        }
        const shim = createShim(message);
        await triviaSkip.execute(shim);
        break;
      }

      case 'leaderboard': {
        const VALID_RANGES = new Set(['day', 'week', 'month', 'all']);
        const range = VALID_RANGES.has(args[0]?.toLowerCase())
          ? args[0].toLowerCase()
          : 'month';

        const shim = createShim(message, { strings: { range } });
        await shim.deferReply();
        await triviaLeaderboard.sendLeaderboard(shim, message.guildId, range);
        break;
      }

      case 'profile': {
        const targetUser = parseFirstMention(message);
        const shim = createShim(message, {
          users: { user: targetUser },
        });
        await triviaProfile.execute(shim);
        break;
      }

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

      case 'help': {
        const pageArg  = parseInt(args[0], 10);
        const startPage = !isNaN(pageArg) && pageArg >= 1
          ? Math.min(pageArg - 1, 5)
          : 0;

        const shim = createShim(message);
        await shim.deferReply();
        await triviaHelp.sendHelp(shim, startPage);
        break;
      }

      case 'stats': {
        const shim = createShim(message);
        await triviaStats.sendStats(shim, message.guildId);
        break;
      }

      case 'duel': {
        const opponent = parseFirstMention(message);
        if (!opponent) {
          await message.reply('⚠️ يجب الإشارة إلى الخصم! مثال: `!trivia duel @أحمد 50`');
          return;
        }
        const stake = parseInt(args[1], 10) || 0;
        const shim = createShim(message, {
          users: { opponent },
          integers: { stake },
          strings: { category: 'all' },
        });
        await triviaDuel.execute(shim);
        break;
      }

      case 'survival': {
        const questions = parseInt(args[0], 10) || 15;
        const shim = createShim(message, { integers: { questions } });
        await triviaSurvival.execute(shim);
        break;
      }

      case 'teams': {
        const questions = parseInt(args[0], 10) || 10;
        const shim = createShim(message, { integers: { questions } });
        await triviaTeams.execute(shim);
        break;
      }

      case 'daily': {
        const shim = createShim(message);
        await triviaDaily.execute(shim);
        break;
      }

      case 'shop': {
        const shim = createShim(message);
        await triviaShop.execute(shim);
        break;
      }

      case 'inventory': {
        const shim = createShim(message);
        await triviaInventory.execute(shim);
        break;
      }

      case 'economy': {
        const action = args[0]?.toLowerCase();
        let subcmd = 'balance';
        let targetUser = null;
        let amount = null;

        if (action === 'top') {
          subcmd = 'top';
        } else if (action === 'transfer' || action === 'pay' || action === 'give') {
          subcmd = 'transfer';
          targetUser = parseFirstMention(message);
          amount = parseInt(args[2], 10) || parseInt(args[1], 10) || 0;
        } else {
          targetUser = parseFirstMention(message);
        }

        const shim = createShim(message, {
          subcommands: [subcmd],
          users: { user: targetUser, recipient: targetUser },
          integers: { amount },
        });
        await triviaEconomy.execute(shim);
        break;
      }

      case 'clan': {
        const action = args[0]?.toLowerCase() || 'info';
        const tag = args[1] || null;
        const shim = createShim(message, {
          subcommands: [action],
          strings: { tag, name: args[1], emoji: args[2], description: args.slice(3).join(' ') },
        });
        await triviaClan.execute(shim);
        break;
      }

      case 'quest': {
        const shim = createShim(message);
        await triviaQuest.execute(shim);
        break;
      }

      case 'season': {
        const shim = createShim(message);
        await triviaSeason.execute(shim);
        break;
      }

      case 'custom': {
        const shim = createShim(message, {
          subcommands: [args[0]?.toLowerCase() || 'list'],
        });
        await triviaCustom.execute(shim);
        break;
      }

      case 'dashboard': {
        const shim = createShim(message);
        await triviaDashboard.execute(shim);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`[PrefixRouter][${sub}]`, err);
    await message.channel.send(
      '⛔ حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مجدداً.'
    ).catch(() => {});
  }
}

module.exports = { handlePrefixCommand };

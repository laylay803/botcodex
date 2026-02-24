require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const TelegramBot = require('node-telegram-bot-api');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const cfg = {
  mcHost: process.env.MC_HOST || 'mc.masedworld.net',
  mcPort: Number(process.env.MC_PORT || 25565),
  mcUsername: process.env.MC_USERNAME,
  mcPassword: process.env.MC_PASSWORD || undefined,
  mcVersion: process.env.MC_VERSION || '1.12.2',
  targetServerCommand: process.env.MC_TARGET_SERVER_COMMAND || '/s1',
  joinDelayMs: Number(process.env.MC_JOIN_DELAY_MS || 3000),
  reconnectDelayMs: Number(process.env.MC_RECONNECT_DELAY_MS || 10000),
  trackedPlayersFile: process.env.TRACKED_PLAYERS_FILE || 'tracked_players.txt',

  discordToken: process.env.DISCORD_TOKEN,
  discordChannelId: process.env.DISCORD_CHANNEL_ID,

  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

if (!cfg.mcUsername) {
  console.error('❌ Укажите MC_USERNAME в .env');
  process.exit(1);
}

const trackedPlayersPath = path.resolve(process.cwd(), cfg.trackedPlayersFile);
let trackedPlayers = new Set();

function loadTrackedPlayers() {
  try {
    const raw = fs.readFileSync(trackedPlayersPath, 'utf8');
    trackedPlayers = new Set(
      raw
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter((v) => v && !v.startsWith('#'))
    );
    console.log(`📋 Загружено отслеживаемых игроков: ${trackedPlayers.size}`);
  } catch (error) {
    console.warn(`⚠️ Не удалось прочитать ${cfg.trackedPlayersFile}: ${error.message}`);
    trackedPlayers = new Set();
  }
}

loadTrackedPlayers();
if (fs.existsSync(trackedPlayersPath)) {
  fs.watchFile(trackedPlayersPath, { interval: 1000 }, () => {
    console.log('🔄 Файл отслеживаемых игроков изменился, перезагружаю...');
    loadTrackedPlayers();
  });
}

const telegram = cfg.telegramToken ? new TelegramBot(cfg.telegramToken, { polling: false }) : null;

async function sendTelegram(text) {
  if (!telegram || !cfg.telegramChatId) return;
  try {
    await telegram.sendMessage(cfg.telegramChatId, text);
  } catch (error) {
    console.warn(`⚠️ Telegram send failed: ${error.message}`);
  }
}

const discordClient = cfg.discordToken
  ? new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    })
  : null;

let bot = null;
let reconnectTimer = null;
let stdinInterface = null;
let spawnCount = 0;
let hasJoinedTargetServer = false;
const onlinePlayers = new Set();

function tryFixJsonLikePayload(raw) {
  const normalized = raw.replace(/([,{]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
  JSON.parse(normalized);
  return normalized;
}

function sanitizeSkinPropertiesInPlayerInfoPacket(packet) {
  const entries = Array.isArray(packet?.data) ? packet.data : [];
  for (const entry of entries) {
    const props = Array.isArray(entry?.properties) ? entry.properties : [];
    for (const prop of props) {
      if (!prop || prop.name !== 'textures' || typeof prop.value !== 'string') continue;

      let decoded;
      try {
        decoded = Buffer.from(prop.value, 'base64').toString('utf8');
      } catch (_error) {
        continue;
      }

      try {
        JSON.parse(decoded);
      } catch (_error) {
        try {
          const fixed = tryFixJsonLikePayload(decoded);
          prop.value = Buffer.from(fixed, 'utf8').toString('base64');
          console.log('🩹 Исправлен некорректный JSON в textures у player_info пакета');
        } catch (_fixError) {
          // keep original value; global handlers below still protect process
        }
      }
    }
  }
}

function forceReconnect(reason) {
  if (bot) {
    try {
      bot.quit(reason);
    } catch (_error) {
      // ignore and fallback to end
    }
  }
  scheduleReconnect(reason);
}

async function sendDiscord(text) {
  if (!discordClient || !cfg.discordChannelId) return;
  try {
    const channel = await discordClient.channels.fetch(cfg.discordChannelId);
    if (!channel || !channel.isTextBased()) return;
    await channel.send(text.slice(0, 1900));
  } catch (error) {
    console.warn(`⚠️ Discord send failed: ${error.message}`);
  }
}

function setupTerminalInput() {
  if (stdinInterface) return;

  stdinInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  stdinInterface.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    if (!bot || !bot.chat) {
      console.log('⚠️ Бот ещё не подключён к Minecraft');
      return;
    }

    try {
      bot.chat(text);
      console.log(`🧑‍💻 [Вы -> MC] ${text}`);
    } catch (error) {
      console.warn(`⚠️ Не удалось отправить сообщение в MC: ${error.message}`);
    }
  });
}

function shouldTryJoinServer(message) {
  const s = message.toLowerCase();
  return s.includes('лобби') || s.includes('lobby') || s.includes('hub') || s.includes('выберите сервер');
}

function joinTargetServer(reason = 'auto') {
  if (!bot) return;
  setTimeout(() => {
    if (!bot) return;
    try {
      bot.chat(cfg.targetServerCommand);
      hasJoinedTargetServer = true;
      console.log(`🚀 Отправлена команда ${cfg.targetServerCommand} (${reason})`);
    } catch (error) {
      console.warn(`⚠️ Ошибка отправки ${cfg.targetServerCommand}: ${error.message}`);
    }
  }, cfg.joinDelayMs);
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.log(`🔁 Переподключение через ${cfg.reconnectDelayMs}ms. Причина: ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, cfg.reconnectDelayMs);
}

function setupDiscordBridge() {
  if (!discordClient) return;

  discordClient.once('ready', () => {
    console.log(`🤖 Discord bot запущен как ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', (msg) => {
    if (msg.author.bot) return;
    if (msg.channelId !== cfg.discordChannelId) return;
    if (!bot) return;

    const text = msg.content.trim();
    if (!text) return;

    try {
      bot.chat(text);
      console.log(`💬 [Discord -> MC] ${msg.author.username}: ${text}`);
    } catch (error) {
      console.warn(`⚠️ Ошибка отправки из Discord в MC: ${error.message}`);
    }
  });

  discordClient.login(cfg.discordToken).catch((error) => {
    console.warn(`⚠️ Discord login failed: ${error.message}`);
  });
}

function handlePlayerJoin(username) {
  if (!username || username === cfg.mcUsername) return;

  const wasOnline = onlinePlayers.has(username);
  onlinePlayers.add(username);

  if (!wasOnline && trackedPlayers.has(username)) {
    const text = `👤 Игрок ${username} зашёл на сервер.`;
    console.log(`🔔 ${text}`);
    sendTelegram(text);
  }
}

function createBot() {
  hasJoinedTargetServer = false;

  bot = mineflayer.createBot({
    host: cfg.mcHost,
    port: cfg.mcPort,
    username: cfg.mcUsername,
    password: cfg.mcPassword,
    version: cfg.mcVersion,
    hideErrors: true,
  });

  bot.once('login', () => {
    console.log(`✅ Успешный вход в Minecraft как ${cfg.mcUsername}`);
  });

  if (bot._client?.prependListener) {
    bot._client.prependListener('player_info', (packet) => {
      sanitizeSkinPropertiesInPlayerInfoPacket(packet);
    });
  }

  bot.once('spawn', () => {
    spawnCount += 1;
    console.log(`🌍 Spawn #${spawnCount}`);

    onlinePlayers.clear();
    Object.keys(bot.players || {}).forEach((name) => {
      if (name) onlinePlayers.add(name);
    });

    joinTargetServer('spawn');
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (!text) return;

    console.log(`[MC] ${text}`);
    sendDiscord(`📨 ${text}`);

    if (!hasJoinedTargetServer && shouldTryJoinServer(text)) {
      joinTargetServer('detected_lobby');
    }

    const joinMatch = text.match(/(?:\+|»|>)\s*([A-Za-z0-9_]{3,16})\s*(?:joined|заш[её]л|вош[её]л)/i);
    if (joinMatch) {
      handlePlayerJoin(joinMatch[1]);
    }
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const line = `💬 ${username}: ${message}`;
    console.log(line);
    sendDiscord(line);
  });

  bot.on('playerJoined', (player) => {
    if (!player?.username) return;
    handlePlayerJoin(player.username);
  });

  bot.on('playerLeft', (player) => {
    if (!player?.username) return;
    onlinePlayers.delete(player.username);
  });

  bot.on('kicked', (reason) => {
    console.warn(`⚠️ Бот кикнут: ${reason}`);
    scheduleReconnect('kicked');
  });

  bot.on('error', (error) => {
    console.warn(`⚠️ Ошибка бота: ${error.message}`);
    scheduleReconnect('error');
  });

  bot.on('end', (reason) => {
    console.warn(`⚠️ Соединение завершено: ${reason}`);
    scheduleReconnect('end');
  });
}

setupTerminalInput();
setupDiscordBridge();

process.on('uncaughtException', (error) => {
  const details = String(error?.stack || error?.message || error);
  const isBadSkinPayload =
    error?.name === 'SyntaxError' && details.includes('extractSkinInformation') && details.includes('JSON.parse');

  if (isBadSkinPayload) {
    console.warn('⚠️ Поймана ошибка парсинга скина от сервера, запускаю переподключение...');
    console.warn(details);
    forceReconnect('skin_parse_error');
    return;
  }

  console.error('❌ Необработанная ошибка процесса:');
  console.error(details);
  forceReconnect('uncaught_exception');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Необработанный promise reject:');
  console.error(reason);
});

createBot();

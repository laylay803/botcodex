require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const TelegramBot = require('node-telegram-bot-api');
const Jimp = require('jimp');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');

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
  restartPlayersFile: process.env.RESTART_PLAYERS_FILE || 'restart_players.txt',

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
const restartPlayersPath = path.resolve(process.cwd(), cfg.restartPlayersFile);
let trackedPlayers = new Set();
let restartPlayers = new Set();

function readNickList(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return new Set(
    raw
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter((v) => v && !v.startsWith('#'))
  );
}

function loadTrackedPlayers() {
  try {
    trackedPlayers = readNickList(trackedPlayersPath);
    console.log(`📋 Загружено отслеживаемых игроков: ${trackedPlayers.size}`);
  } catch (error) {
    console.warn(`⚠️ Не удалось прочитать ${cfg.trackedPlayersFile}: ${error.message}`);
    trackedPlayers = new Set();
  }
}

function loadRestartPlayers() {
  try {
    restartPlayers = readNickList(restartPlayersPath);
    console.log(`♻️ Загружено игроков с правом @restart: ${restartPlayers.size}`);
  } catch (error) {
    console.warn(`⚠️ Не удалось прочитать ${cfg.restartPlayersFile}: ${error.message}`);
    restartPlayers = new Set();
  }
}

loadTrackedPlayers();
loadRestartPlayers();

function watchListFile(filePath, label, loader) {
  if (!fs.existsSync(filePath)) return;
  fs.watchFile(filePath, { interval: 1000 }, () => {
    console.log(`🔄 ${label} изменился, перезагружаю...`);
    loader();
  });
}

watchListFile(trackedPlayersPath, 'Файл отслеживаемых игроков', loadTrackedPlayers);
watchListFile(restartPlayersPath, 'Файл игроков с правом рестарта', loadRestartPlayers);

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
let isStoppedManually = false;
const onlinePlayers = new Set();

function nowStamp() {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

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
        } catch (_fixError) {
          // keep original value; global handlers below still protect process
        }
      }
    }
  }
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function forceReconnect(reason) {
  if (bot) {
    try {
      bot.quit(reason);
    } catch (_error) {
      // ignore and fallback to schedule
    }
  }
  scheduleReconnect(reason);
}

async function getDiscordChannel() {
  if (!discordClient || !cfg.discordChannelId) return null;
  try {
    const channel = await discordClient.channels.fetch(cfg.discordChannelId);
    return channel && channel.isTextBased() ? channel : null;
  } catch (error) {
    console.warn(`⚠️ Discord channel fetch failed: ${error.message}`);
    return null;
  }
}

async function sendDiscord(content) {
  const channel = await getDiscordChannel();
  if (!channel) return;

  try {
    if (typeof content === 'string') {
      await channel.send(content.slice(0, 1900));
      return;
    }

    await channel.send(content);
  } catch (error) {
    console.warn(`⚠️ Discord send failed: ${error.message}`);
  }
}

async function sendDiscordEvent(title, color, description) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(description)
    .setFooter({ text: `BotCodex • ${nowStamp()}` });

  await sendDiscord({ embeds: [embed] });
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
  if (!bot || isStoppedManually) return;
  setTimeout(() => {
    if (!bot || isStoppedManually) return;
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
  if (isStoppedManually) {
    console.log(`⏸️ Реконнект отменён: бот остановлен вручную. Причина отключения: ${reason}`);
    return;
  }

  if (reconnectTimer) return;
  console.log(`🔁 Переподключение через ${cfg.reconnectDelayMs}ms. Причина: ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, cfg.reconnectDelayMs);
}

async function stopBot(source) {
  isStoppedManually = true;
  clearReconnectTimer();

  if (bot) {
    try {
      bot.quit('manual_stop');
    } catch (_error) {
      // ignore
    }
  }

  bot = null;
  await sendDiscordEvent('⏹️ Бот остановлен', 0xed4245, `Источник: ${source}`);
}

async function startBot(source) {
  if (bot) {
    await sendDiscordEvent('ℹ️ Бот уже запущен', 0x5865f2, `Источник: ${source}`);
    return;
  }

  isStoppedManually = false;
  clearReconnectTimer();
  createBot();
  await sendDiscordEvent('▶️ Запуск бота', 0x57f287, `Источник: ${source}`);
}

async function restartBot(source) {
  isStoppedManually = false;
  clearReconnectTimer();

  if (bot) {
    try {
      bot.quit('manual_restart');
    } catch (_error) {
      // ignore
    }
  }

  bot = null;
  createBot();
  await sendDiscordEvent('🔁 Перезапуск бота', 0xfaa61a, `Источник: ${source}`);
}

async function createTabScreenshotBuffer() {
  const names = Object.keys(bot?.players || {})
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'ru'));

  const title = `TAB (${names.length})`;
  const lines = [title, ...names];

  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  const lineHeight = 20;
  const padding = 20;
  const width = 760;
  const height = padding * 2 + lines.length * lineHeight;

  const image = new Jimp(width, Math.max(120, height), 0x101317ff);

  image.print(font, padding, 10, `Minecraft tab-list • ${new Date().toLocaleString('ru-RU')}`);

  lines.forEach((line, index) => {
    const prefix = index === 0 ? '📋 ' : `${String(index).padStart(2, '0')}. `;
    image.print(font, padding, padding + 20 + index * lineHeight, `${prefix}${line}`);
  });

  return image.getBufferAsync(Jimp.MIME_PNG);
}

async function sendTabToDiscord(source) {
  if (!bot) {
    await sendDiscordEvent('⚠️ TAB недоступен', 0xfee75c, `Бот не подключён. Источник: ${source}`);
    return;
  }

  try {
    const png = await createTabScreenshotBuffer();
    const attachment = new AttachmentBuilder(png, { name: `tab-${Date.now()}.png` });
    await sendDiscord({
      content: `📸 TAB-скриншот (${source})`,
      files: [attachment],
    });
  } catch (error) {
    console.warn(`⚠️ Не удалось создать TAB-изображение: ${error.message}`);
    await sendDiscordEvent('❌ Ошибка TAB', 0xed4245, `Не удалось собрать PNG: ${error.message}`);
  }
}

function parseControlCommand(text) {
  const cmd = text.trim().toLowerCase();
  if (cmd === '@stop') return 'stop';
  if (cmd === '@start') return 'start';
  if (cmd === '@restart') return 'restart';
  if (cmd === '@tab') return 'tab';
  return null;
}

async function runControlCommand(command, sourceLabel) {
  if (command === 'stop') return stopBot(sourceLabel);
  if (command === 'start') return startBot(sourceLabel);
  if (command === 'restart') return restartBot(sourceLabel);
  if (command === 'tab') return sendTabToDiscord(sourceLabel);
}

function setupDiscordBridge() {
  if (!discordClient) return;

  discordClient.once('clientReady', () => {
    console.log(`🤖 Discord bot запущен как ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (msg.channelId !== cfg.discordChannelId) return;

    const text = msg.content.trim();
    if (!text) return;

    const command = parseControlCommand(text);
    if (command) {
      await runControlCommand(command, `Discord: ${msg.author.tag}`);
      return;
    }

    if (!bot) return;

    try {
      bot.chat(text);
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
    sendDiscordEvent('🟢 Бот в сети', 0x57f287, `Аккаунт: **${cfg.mcUsername}**`);
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
    sendDiscord(`💬 **[${nowStamp()}]** ${text}`);

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

    const command = parseControlCommand(message);
    if (command && restartPlayers.has(username)) {
      runControlCommand(command, `Minecraft: ${username}`);
      return;
    }

    const line = `💬 ${username}: ${message}`;
    console.log(line);
    sendDiscord(`💬 **[${nowStamp()}] ${username}:** ${message}`);
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
    sendDiscordEvent('🔴 Бот отключился', 0xed4245, `Причина: ${reason || 'unknown'}`);
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

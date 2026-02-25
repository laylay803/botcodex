# Minecraft 1.12.2 Bot (mc.masedworld.net)

Бот на Node.js + mineflayer, который:

- подключается к `mc.masedworld.net` (1.12.2);
- ждёт 3 секунды и пишет `/s1`;
- показывает чат Minecraft в терминале;
- принимает сообщения из терминала и отправляет их в чат;
- автоматически переподключается при вылете/разрыве;
- при обнаружении лобби снова отправляет `/s1`;
- автоматически пытается исправлять некорректный skin JSON в пакетах сервера (чтобы не падать на `extractSkinInformation`);
- отслеживает вход определённых игроков из `tracked_players.txt` и отправляет уведомление в Telegram;
- пересылает чат Minecraft в Discord с более аккуратным форматированием;
- принимает управляющие команды в Discord:
  - `@stop` — остановить бота;
  - `@start` — запустить бота;
  - `@restart` — перезапустить бота;
  - `@tab` — отправить PNG с текущим TAB-списком игроков в Discord;
- в Minecraft выполняет только `@restart` и только от ников из `restart_players.txt`;
- не отправляет управляющие команды из Discord в Minecraft чат.

## 1) Установка

```bash
npm install
```

## 2) Настройка

1. Скопируйте пример окружения:

```bash
cp .env.example .env
```

2. Заполните `.env`:

- `MC_USERNAME` — логин бота в Minecraft (обязательно).
- `MC_PASSWORD` — пароль (если нужен премиум-аккаунт).
- `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID` — для моста Discord.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — для уведомлений в Telegram.
- `RESTART_PLAYERS_FILE` — файл с никами, которым разрешён `@restart` из Minecraft-чата.

3. Добавьте ники:

- в `tracked_players.txt` — кого отслеживать для уведомлений в Telegram;
- в `restart_players.txt` — кто может давать `@restart` в Minecraft.

## 3) Запуск

```bash
npm start
```

После запуска:
- всё, что вы пишете в терминал, отправляется ботом в Minecraft;
- весь входящий чат Minecraft отображается в терминале;
- из Discord-канала можно управлять ботом через команды `@stop`, `@start`, `@restart`, `@tab`.

## Примечания

- Версия Minecraft задаётся через `MC_VERSION=1.12.2`.
- Команда входа на сервер задаётся через `MC_TARGET_SERVER_COMMAND=/s1`.
- Задержка перед отправкой команды задаётся через `MC_JOIN_DELAY_MS=3000`.

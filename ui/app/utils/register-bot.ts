import type { B24Frame } from '@bitrix24/b24jssdk'

// Регистрация чат-бота «Импорт счетов» при установке приложения (issue #217).
//
// ВАЖНО про SDK: вызовы REST идут через v2-экшен `frame.actions.v2.call.make({ method, params })`
// — это актуальный API @bitrix24/b24jssdk. НЕ используем устаревший глобал `BX24.callMethod`.
//
// Методы Б24 (сверено с офиц. докой):
//   • imbot.v2.Bot.register — параметры В `fields`, `type:'bot'` (НЕ 'B'), `eventMode:'webhook'`,
//     `webhookUrl` обязателен. Идемпотентен: повторная регистрация с тем же `code` вернёт того же бота.
//     botToken НЕ передаём — регистрируемся через OAuth (iframe); события приходят с OAuth-токеном
//     бота (data.bot.auth.access_token), на нём backend и зовёт imbot.* в ответ.
//   • imbot.command.register — команда `feedback` для кнопок 👍/👎; PHP-ключи BOT_ID/COMMAND/LANG/…

export const BOT_CODE = 'procure_ai_invoice'
export const FEEDBACK_COMMAND = 'feedback'

export interface BotRegistration { botId: number, commandId: number }

/**
 * Зарегистрировать бота + команду feedback. Бросает при ошибке REST (caller — best-effort).
 * @param frame активный B24Frame (внутри портала)
 * @param webhookUrl публичный URL обработчика событий бота — наш backend `POST /b24/bot/event`
 */
export async function registerInvoiceBot(frame: B24Frame, webhookUrl: string): Promise<BotRegistration> {
  const reg = await frame.actions.v2.call.make<{ bot: { id: number } }>({
    method: 'imbot.v2.Bot.register',
    params: {
      fields: {
        code: BOT_CODE,
        type: 'bot',
        eventMode: 'webhook',
        webhookUrl,
        properties: { name: 'Импорт счетов', workPosition: 'Бросьте счёт — создам сделку' }
      }
    }
  })
  if (!reg.isSuccess) {
    throw new Error(`imbot.v2.Bot.register: ${reg.getErrorMessages().join('; ')}`)
  }
  const botId = reg.getData()?.result?.bot?.id
  if (typeof botId !== 'number') {
    throw new Error('imbot.v2.Bot.register: ответ без bot.id')
  }

  // Команда feedback (для кнопок 👍/👎). ⚠️ ПОРТАЛ-QA №1 (v1/v2): `imbot.command.register` —
  // legacy-метод (v2-аналога `imbot.v2.Command.register` в доке НЕТ); его штатное событие —
  // `ONIMCOMMANDADD`, а наш backend разбирает v2-событие `ONIMBOTV2COMMANDADD`. Доставит ли v2-бот
  // (eventMode:webhook) клик команды как `ONIMBOTV2COMMANDADD` — официально НЕ подтверждено,
  // проверяется только на живом портале. Если нет — переключиться на кнопки `ACTION:'SEND'` (клик
  // шлёт текст → обычный ONIMBOTV2MESSAGEADD, парсим текст) — см. docs/B24_BOT.md §7.
  // EVENT_COMMAND_ADD ставим на наш же /b24/bot/event; HIDDEN:'Y' — служебная (вызывается кнопкой).
  const cmd = await frame.actions.v2.call.make<number>({
    method: 'imbot.command.register',
    params: {
      BOT_ID: botId,
      COMMAND: FEEDBACK_COMMAND,
      EVENT_COMMAND_ADD: webhookUrl,
      HIDDEN: 'Y',
      LANG: [
        { LANGUAGE_ID: 'ru', TITLE: 'Отзыв', PARAMS: 'like|dislike <jobId>' },
        { LANGUAGE_ID: 'en', TITLE: 'Feedback', PARAMS: 'like|dislike <jobId>' }
      ]
    }
  })
  if (!cmd.isSuccess) {
    throw new Error(`imbot.command.register: ${cmd.getErrorMessages().join('; ')}`)
  }
  const commandId = cmd.getData()?.result
  if (typeof commandId !== 'number') {
    throw new Error('imbot.command.register: ответ без id команды')
  }
  return { botId, commandId }
}

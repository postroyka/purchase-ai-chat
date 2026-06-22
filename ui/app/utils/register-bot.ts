import type { B24Frame } from '@bitrix24/b24jssdk'

// Регистрация чат-бота «Импорт счетов» при установке приложения (issue #217).
//
// ⚠️ LEGACY-режим (портал заказчика старый — `imbot.v2.*` отдаёт 404). Используем устаревший, но
// широко поддерживаемый API: `imbot.register`. Свежий v2-путь НЕ удалён — закомментирован ниже
// блоком «=== v2 (вернуть при тираже) ===»; на новом портале вернёмся к нему.
//
// ВАЖНО про SDK: вызовы REST идут через v2-экшен `frame.actions.v2.call.make({ method, params })`
// — это актуальный API @bitrix24/b24jssdk (НЕ путать с imbot.v2.*); им можно звать ЛЮБОЙ REST-метод,
// включая legacy. НЕ используем устаревший глобал `BX24.callMethod`.
//
// Методы Б24 (legacy, сверено с офиц. докой):
//   • imbot.register — CODE, TYPE:'B' (стандартный бот), EVENT_HANDLER (один URL на все события бота:
//     ONIMBOTMESSAGEADD/ONIMBOTJOINCHAT/ONIMBOTDELETE), PROPERTIES.NAME. Возвращает BOT_ID (integer).
//     Идемпотентность по CODE не гарантируется так же, как у v2 — повторная установка может создать
//     дубль; для нашего сценария (установка один раз) приемлемо.
//   • imbot.command.register — команда `feedback` для кнопок 👍/👎; событие клика — ONIMCOMMANDADD.

export const BOT_CODE = 'procure_ai_invoice'
export const FEEDBACK_COMMAND = 'feedback'

export interface BotRegistration { botId: number, commandId: number }

/**
 * Зарегистрировать бота + команду feedback (legacy). Бросает при ошибке REST (caller — best-effort).
 * @param frame активный B24Frame (внутри портала)
 * @param webhookUrl публичный URL обработчика событий бота — наш backend `POST /b24/bot/event`
 */
export async function registerInvoiceBot(frame: B24Frame, webhookUrl: string): Promise<BotRegistration> {
  // imbot.register: EVENT_HANDLER копируется во все EVENT_* (сообщение/приветствие/удаление) → одна точка.
  const reg = await frame.actions.v2.call.make<number>({
    method: 'imbot.register',
    params: {
      CODE: BOT_CODE,
      TYPE: 'B',
      OPENLINE: 'N',
      EVENT_HANDLER: webhookUrl,
      PROPERTIES: { NAME: 'Импорт счетов', WORK_POSITION: 'Бросьте счёт — создам сделку' }
    }
  })
  if (!reg.isSuccess) {
    throw new Error(`imbot.register: ${reg.getErrorMessages().join('; ')}`)
  }
  // Ответ imbot.register — это сам BOT_ID (integer) в result.
  const botId = reg.getData()?.result
  if (typeof botId !== 'number') {
    throw new Error('imbot.register: ответ без BOT_ID')
  }

  // Команда feedback (для кнопок 👍/👎). EVENT_COMMAND_ADD — на наш же /b24/bot/event; клик порождает
  // событие ONIMCOMMANDADD. HIDDEN:'Y' — служебная (вызывается кнопкой, не из списка команд).
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

// === v2 (вернуть при тираже — #243; портал заказчика старый, imbot.v2.* → 404) =====================
// На современном Битрикс24 регистрировать бота надо через чат-боты 2.0 (события ONIMBOTV2*):
//
//   const reg = await frame.actions.v2.call.make<{ bot: { id: number } }>({
//     method: 'imbot.v2.Bot.register',
//     params: {
//       fields: {
//         code: BOT_CODE,
//         type: 'bot',                 // НЕ 'B'
//         eventMode: 'webhook',        // авто-подписка на ONIMBOTV2*
//         webhookUrl,                  // обязателен; botToken НЕ шлём (OAuth)
//         properties: { name: 'Импорт счетов', workPosition: 'Бросьте счёт — создам сделку' }
//       }
//     }
//   })
//   if (!reg.isSuccess) throw new Error(`imbot.v2.Bot.register: ${reg.getErrorMessages().join('; ')}`)
//   const botId = reg.getData()?.result?.bot?.id          // ответ вложен: result.bot.id
//   // …далее imbot.command.register (как выше — он один на оба режима).
//
// При возврате к v2 также вернуть в backend разбор событий ONIMBOTV2* (b24-bot.js) и imbot.v2.File.download
// (b24-bot-api.js) — они там тоже закомментированы тем же маркером.
// ===================================================================================================

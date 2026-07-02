// Страница-заглушка «сервис приостановлен» (env-рубильник MAINTENANCE_MODE, см. index.js).
// Полностью автономный HTML (инлайн CSS/SVG, без внешних ресурсов) — отдаётся при включённом
// режиме обслуживания вместо приложения. По задумке: при загрузке страницы машинка «выезжает»
// (CSS-анимация), снизу — подпись-причина паузы.

/** Экранирование для безопасной вставки текста в HTML (сообщение приходит из env). */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML страницы-заглушки.
 * @param {string} message — подпись снизу (причина паузы). По умолчанию — «Подписание актов выполненных работ».
 * @returns {string} полный HTML-документ.
 */
export function renderMaintenancePage(message = 'Подписание актов выполненных работ') {
  const note = escapeHtml(message);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Сервис временно приостановлен</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, #cfe8ff 0%, #eef6ff 55%, #f7fbff 100%);
    color: #1b2733;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; overflow: hidden; text-align: center; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(180deg, #0b1622 0%, #10202f 55%, #142534 100%); color: #e6eef6; }
    .road { background: #1a2836; }
    .lane { background: #46617a; }
    .headline { color: #e6eef6; }
    .note { color: #cfe0ee; }
  }

  .scene { width: min(680px, 92vw); }

  /* Дорога + разметка */
  .road {
    position: relative; height: 70px; border-radius: 10px;
    background: #33455a; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.18);
  }
  .lane {
    position: absolute; top: 50%; left: 0; height: 4px; width: 200%;
    transform: translateY(-50%);
    background: repeating-linear-gradient(90deg, #ffd166 0 34px, transparent 34px 68px);
    opacity: .85; animation: lane 1.1s linear infinite;
  }
  @keyframes lane { from { transform: translate(0, -50%); } to { transform: translate(-68px, -50%); } }

  /* Машинка: выезжает слева при загрузке, затем «покачивается» */
  .car {
    position: absolute; bottom: 8px; left: 0; width: 132px; height: 46px;
    animation: drive 2.2s cubic-bezier(.22,.61,.36,1) forwards;
    transform: translateX(-160px);
  }
  @keyframes drive {
    0%   { transform: translateX(-170px); }
    100% { transform: translateX(calc(50% - 4px)); }
  }
  .car .body-svg { display: block; filter: drop-shadow(0 6px 6px rgba(0,0,0,.25)); animation: bounce 0.9s ease-in-out 2.2s infinite; }
  @keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
  .wheel { transform-origin: center; animation: spin .5s linear infinite; }

  @keyframes spin { to { transform: rotate(360deg); } }
  /* Уважаем reduced-motion: без бесконечных крутилок, машинка просто стоит на месте */
  @media (prefers-reduced-motion: reduce) {
    .lane, .car, .body-svg, .wheel { animation: none !important; }
    .car { transform: translateX(calc(50% - 4px)); }
  }

  .headline { margin: 26px 0 6px; font-size: clamp(20px, 3.4vw, 30px); font-weight: 700; color: #16324f; }
  .sub { margin: 0; font-size: clamp(14px, 2.2vw, 17px); opacity: .8; }
  .note {
    margin-top: 30px; font-size: clamp(15px, 2.6vw, 19px); font-weight: 600;
    color: #16324f; letter-spacing: .2px;
  }
  .note::before { content: "✍️ "; }
</style>
</head>
<body>
  <div class="scene">
    <div class="road">
      <div class="lane"></div>
      <div class="car">
        <svg class="body-svg" width="132" height="46" viewBox="0 0 132 46" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 32 L18 32 L30 16 L82 16 L98 32 L120 32 Q128 32 128 24 L128 34 Q128 40 122 40 L10 40 Q4 40 4 34 L4 34 Z" fill="#e63946"/>
          <path d="M34 18 L54 18 L54 30 L24 30 Z" fill="#a8dadc"/>
          <path d="M58 18 L78 18 L94 30 L58 30 Z" fill="#a8dadc"/>
          <rect x="4" y="30" width="124" height="6" rx="3" fill="#b5202c"/>
          <g class="wheel" style="transform-box: fill-box;">
            <circle cx="34" cy="40" r="9" fill="#222"/>
            <circle cx="34" cy="40" r="3.5" fill="#bbb"/>
          </g>
          <g class="wheel" style="transform-box: fill-box;">
            <circle cx="100" cy="40" r="9" fill="#222"/>
            <circle cx="100" cy="40" r="3.5" fill="#bbb"/>
          </g>
        </svg>
      </div>
    </div>

    <h1 class="headline">Сервис временно приостановлен</h1>
    <p class="sub">Приложение недоступно. Попробуйте зайти позже.</p>
    <p class="note">${note}</p>
  </div>
</body>
</html>`;
}

# procure-ai

## Workflow Rules

- **Never push directly to `main`** — all changes go via Pull Requests.
- Before pushing, create a PR and request a code review.
- Merges to `main` are done manually by the repo owner.

## Branch Strategy

- Feature/fix branches: `feature/<name>` or `fix/<name>`
- Development branch for this session: use the branch provided in session context
- Target branch for PRs: `main`

## GitHub API Rate Limits

Квоты считаются раздельно: **REST-core** (5000 **запросов**/час) и **GraphQL**
(5000 **очков**/час — points, не запросы). MCP-инструменты GitHub для записи/поиска/листинга
(`issue_write`, `search_issues`, `list_issues`, резолв `duplicate_of`) ходят через **GraphQL**;
один вложенный list/search стоит >1 очка, поэтому GraphQL выгорает первой, а REST-core остаётся
свободен.

- **Сначала смотри, какая квота кончилась**, не жди вслепую: `curl -s -H "Authorization: Bearer
  $GITHUB_TOKEN_INGEST" https://api.github.com/rate_limit` отдаёт `remaining`+`reset` (epoch) по
  каждому пулу — это **разные** лимиты: `core`, `graphql`, `search`. Поллер на этом эндпоинте
  бесплатен. Жди до нужного `reset` **+2–5 с** (запас на рассинхрон часов).
- **Читай прямым REST**, где можно: `GITHUB_TOKEN_INGEST` (read-only, не трогает GraphQL) — для
  диагностики/enumeration. Для перебора бери постранично `GET
  /repos/{o}/{r}/issues?state=all&per_page=100` (100 issue = 1 запрос) вместо одиночных `GET
  /issues/{n}` (100 запросов); single-GET — только когда нужен конкретный номер.
- **Кэшируй повторные чтения** условными запросами: `If-None-Match: <etag>` → `304` квоту не
  тратит. Только REST; в GraphQL ETag нет.
- **Записи (close/comment/labels/duplicate) — только через MCP** (GraphQL): **батчи** их в один
  заход и **не молоти** `list/search` в цикле — они тоже жрут GraphQL-очки и роняют последующую
  запись.
- **Помни про secondary limits** (отдельный механизм поверх primary, отдают `403`): даже при
  свободной primary-квоте контент-операции режутся на ~**80/мин и 500/час**, плюс ≤100
  одновременных запросов (общий пул REST+GraphQL) и ≤2000 очков/мин на GraphQL. Поэтому записи
  разноси во времени + exponential backoff с jitter, а не лей пачкой.
- `GITHUB_TOKEN_INGEST` — **read-only**: writes через него дают `Resource not accessible`.

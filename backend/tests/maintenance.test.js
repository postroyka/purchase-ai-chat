import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { renderMaintenancePage, DEFAULT_MAINTENANCE_MESSAGE } from '../maintenance-page.js';

// Тихо гасим ожидаемые предупреждения (in-memory store, MAINTENANCE_MODE warn)
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

describe('MAINTENANCE_MODE (env-рубильник)', () => {
  it('выключен по умолчанию — приложение работает, /health отвечает', async () => {
    const app = createApp({ token: 'tok' });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('включён — браузеру (Accept: text/html) отдаётся заглушка 503 с подписью', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true, maintenanceMessage: 'Подписание актов выполненных работ' });
    const res = await request(app).get('/').set('Accept', 'text/html');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['retry-after']).toBe('3600');
    expect(res.text).toContain('Подписание актов выполненных работ');
    expect(res.text).toContain('Сервис временно приостановлен');
  });

  it('включён — API-клиент получает 503 JSON + no-store + Retry-After', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true });
    const res = await request(app).get('/metrics/data').set('Accept', 'application/json');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'maintenance' });
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['retry-after']).toBe('3600');
  });

  it('включён — статик-ассет (Accept без text/html) отдаёт 503 + no-store', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true });
    const res = await request(app).get('/assets/app-abc123.js').set('Accept', '*/*');
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('включён — HEAD-запрос и GET без Accept уходят в 503 (не заглушка)', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true });
    const head = await request(app).head('/');
    expect(head.status).toBe(503);
    expect(head.headers['retry-after']).toBe('3600');
    const noAccept = await request(app).get('/').set('Accept', '');
    expect(noAccept.status).toBe(503);
  });

  it('включён — HTML-заглушка тоже помечена no-store', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true });
    const res = await request(app).get('/').set('Accept', 'text/html');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('включён — загрузка файлов (POST) заблокирована 503', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true });
    const res = await request(app).post('/upload');
    expect(res.status).toBe(503);
  });

  it('включён — /health всё равно 200 (контейнер остаётся healthy)', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('env MAINTENANCE_MODE=1 включает режим', async () => {
    const prev = process.env.MAINTENANCE_MODE;
    process.env.MAINTENANCE_MODE = '1';
    try {
      const app = createApp({ token: 'tok' });
      const res = await request(app).get('/').set('Accept', 'text/html');
      expect(res.status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.MAINTENANCE_MODE;
      else process.env.MAINTENANCE_MODE = prev;
    }
  });

  it('дефолт подписи берётся из общей константы (нет дрейфа между файлами)', async () => {
    const app = createApp({ token: 'tok', maintenanceMode: true }); // message не задан → дефолт
    const res = await request(app).get('/').set('Accept', 'text/html');
    expect(res.text).toContain(DEFAULT_MAINTENANCE_MESSAGE);
    expect(renderMaintenancePage()).toContain(DEFAULT_MAINTENANCE_MESSAGE);
  });

  it('renderMaintenancePage экранирует сообщение из env', () => {
    const html = renderMaintenancePage('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

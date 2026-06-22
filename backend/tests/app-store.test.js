import { describe, it, expect } from 'vitest';
import { createAppStore } from '../app-store.js';

const mem = () => createAppStore({ redisUrl: '' }); // in-memory backend (нет REDIS_URL)

describe('app-store (#217 — захват application_token)', () => {
  it('recordInstall → isKnownToken true; неизвестный/пустой → false', async () => {
    const s = mem();
    expect(await s.isKnownToken('tok-1')).toBe(false);
    expect(await s.recordInstall({ memberId: 'm1', applicationToken: 'tok-1', domain: 'p.bitrix24.by' })).toBe(true);
    expect(await s.isKnownToken('tok-1')).toBe(true);
    expect(await s.isKnownToken('tok-2')).toBe(false);
    expect(await s.isKnownToken('')).toBe(false);
  });

  it('ротация: повтор установки с новым токеном — старый перестаёт быть валидным', async () => {
    const s = mem();
    await s.recordInstall({ memberId: 'm1', applicationToken: 'old' });
    await s.recordInstall({ memberId: 'm1', applicationToken: 'new' });
    expect(await s.isKnownToken('new')).toBe(true);
    expect(await s.isKnownToken('old')).toBe(false);
  });

  it('removeInstall с ВЕРНЫМ токеном чистит; с неверным — не трогает (анти-форс)', async () => {
    const s = mem();
    await s.recordInstall({ memberId: 'm1', applicationToken: 'tok' });
    expect(await s.removeInstall({ memberId: 'm1', applicationToken: 'WRONG' })).toBe(false);
    expect(await s.isKnownToken('tok')).toBe(true); // не стёрли
    expect(await s.removeInstall({ memberId: 'm1', applicationToken: 'tok' })).toBe(true);
    expect(await s.isKnownToken('tok')).toBe(false);
  });

  it('removeInstall без токена (очистка по member_id) работает', async () => {
    const s = mem();
    await s.recordInstall({ memberId: 'm2', applicationToken: 'tok2' });
    expect(await s.removeInstall({ memberId: 'm2' })).toBe(true);
    expect(await s.isKnownToken('tok2')).toBe(false);
  });

  it('два портала независимы (ключ — member_id)', async () => {
    const s = mem();
    await s.recordInstall({ memberId: 'mA', applicationToken: 'tA' });
    await s.recordInstall({ memberId: 'mB', applicationToken: 'tB' });
    await s.removeInstall({ memberId: 'mA', applicationToken: 'tA' });
    expect(await s.isKnownToken('tA')).toBe(false);
    expect(await s.isKnownToken('tB')).toBe(true); // mB не затронут
  });

  it('пустые/битые аргументы — best-effort, без падения', async () => {
    const s = mem();
    expect(await s.recordInstall({})).toBe(false);
    expect(await s.recordInstall({ memberId: 'm', applicationToken: '' })).toBe(false);
    expect(await s.removeInstall({})).toBe(false);
    expect(await s.removeInstall({ memberId: 'нет-такого' })).toBe(false);
  });
});

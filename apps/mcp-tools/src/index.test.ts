import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { handler } from './index.js';
import { parseInput } from './booking.js';
import { bookingSchema, withTransaction } from './database.js';
const period = {
  start_time: '2026-10-29T14:00:00+09:00',
  end_time: '2026-10-29T15:00:00+09:00',
  attendees: 4,
};
describe('予約入力と認証境界', () => {
  it('Asia/Tokyoの日付範囲をUTCに変換する', () => {
    expect(
      parseInput('list_reservations', { date: '2026-10-29' })
    ).toMatchObject({
      start: '2026-10-28T15:00:00.000Z',
      end: '2026-10-29T15:00:00.000Z',
    });
    expect(parseInput('search_available_rooms', period)).toMatchObject({
      start: '2026-10-29T05:00:00.000Z',
      end: '2026-10-29T06:00:00.000Z',
    });
  });
  it.each([
    { ...period, schema: 'booking_auth' },
    { ...period, attendees: 0 },
    { ...period, attendees: 1.5 },
    { ...period, start_time: '2026-02-30T14:00:00+09:00' },
    { ...period, start_time: '2026-10-29T14:00:00' },
    { ...period, end_time: period.start_time },
    { ...period, end_time: '2026-10-31T15:00:00+09:00' },
    { ...period, start_time: '2026-10-29T14:00:00+14:01' },
  ])('不正入力をDB接続前に拒否する: %j', (input) => {
    expect(() => parseInput('search_available_rooms', input)).toThrow();
  });
  it('存在しない日付を拒否する', () =>
    expect(() =>
      parseInput('list_reservations', { date: '2026-02-29' })
    ).toThrow());
  it('未知のツールと任意スキーマを拒否する', async () => {
    expect(() => bookingSchema('public; DROP SCHEMA booking_auth')).toThrow();
    expect(() => bookingSchema(undefined)).toThrow();
    await expect(
      handler(
        {},
        {
          clientContext: {
            custom: { bedrockAgentCoreToolName: 'booking___add_numbers' },
          },
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });
});
describe('DSQLのトランザクション競合', () => {
  it('COMMIT時の40001では処理全体を新しいトランザクションで再試行する', async () => {
    let commits = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql === 'COMMIT' && ++commits === 1)
        throw Object.assign(new Error('conflict'), { code: '40001' });
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as pg.Pool;
    const work = vi.fn(async () => 'done');
    await expect(withTransaction(pool, work)).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'BEGIN',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('権限エラーでは再試行せずROLLBACKする', async () => {
    const query = vi.fn(async () => undefined),
      release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as pg.Pool;
    const work = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { code: '42501' });
    });
    await expect(withTransaction(pool, work)).rejects.toThrow('denied');
    expect(work).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

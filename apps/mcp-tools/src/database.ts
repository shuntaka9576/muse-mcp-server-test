import { DsqlSigner } from '@aws-sdk/dsql-signer';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BookingError, type BookingInput } from './booking.js';
export function createPool(
  host: string,
  region: string,
  user: string
): pg.Pool {
  const signer = new DsqlSigner({ hostname: host, region, expiresIn: 900 });
  return new pg.Pool({
    host,
    user,
    database: 'postgres',
    port: 5432,
    password: () =>
      user === 'admin'
        ? signer.getDbConnectAdminAuthToken()
        : signer.getDbConnectAuthToken(),
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    maxLifetimeSeconds: 300,
  });
}
export function bookingSchema(value: string | undefined): 'booking_auth' {
  if (value !== 'booking_auth') throw new Error('Invalid BOOKING_SCHEMA');
  return value;
}
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code !== '40001' || attempt >= 4)
        throw error;
    } finally {
      client.release();
    }
    await delay(25 * 2 ** attempt + Math.random() * 25);
  }
}
export async function executeBooking(
  pool: pg.Pool,
  schema: ReturnType<typeof bookingSchema>,
  input: BookingInput
): Promise<Record<string, unknown>> {
  const reservations = `${schema}.reservations`,
    rooms = `${schema}.rooms`,
    guards = `${schema}.booking_guards`;
  if (input.tool === 'search_available_rooms') {
    const result = await pool.query(
      `SELECT r.room_id, r.name, r.capacity FROM ${rooms} r WHERE r.capacity >= $3 AND NOT EXISTS (SELECT 1 FROM ${reservations} b WHERE b.room_id = r.room_id AND b.start_time < $2::timestamptz AND b.end_time > $1::timestamptz) ORDER BY r.capacity, r.room_id`,
      [input.start, input.end, input.attendees]
    );
    return { ok: true, timezone: 'Asia/Tokyo', rooms: result.rows };
  }
  if (input.tool === 'list_reservations') {
    const result = await pool.query(
      `SELECT b.*, r.name AS room_name FROM ${reservations} b JOIN ${rooms} r ON r.room_id = b.room_id WHERE b.start_time < $2::timestamptz AND b.end_time > $1::timestamptz ORDER BY b.start_time, b.reservation_id`,
      [input.start, input.end]
    );
    return {
      ok: true,
      date: input.date,
      timezone: 'Asia/Tokyo',
      reservations: result.rows,
    };
  }
  if (input.tool === 'create_reservation') {
    const id = randomUUID();
    return withTransaction(pool, async (client) => {
      // 同じ会議室への書き込みを競合させ、スナップショット分離のwrite skewを防ぐ。
      const guard = await client.query(
        `UPDATE ${guards} SET version = version + 1 WHERE room_id = $1`,
        [input.roomId]
      );
      if (guard.rowCount !== 1)
        throw new BookingError('ROOM_NOT_FOUND', '会議室が見つかりません。');
      const room = (
        await client.query(`SELECT * FROM ${rooms} WHERE room_id = $1`, [
          input.roomId,
        ])
      ).rows[0];
      if (!room)
        throw new BookingError('ROOM_NOT_FOUND', '会議室が見つかりません。');
      if (room.capacity < input.attendees)
        throw new BookingError(
          'CAPACITY_EXCEEDED',
          '人数が会議室の定員を超えています。'
        );
      const conflict = await client.query(
        `SELECT reservation_id FROM ${reservations} WHERE room_id = $1 AND start_time < $3::timestamptz AND end_time > $2::timestamptz LIMIT 1`,
        [input.roomId, input.start, input.end]
      );
      if (conflict.rowCount)
        throw new BookingError(
          'ROOM_UNAVAILABLE',
          '指定の時間帯は予約済みです。空き状況を再検索してください。'
        );
      const result = await client.query(
        `INSERT INTO ${reservations} (reservation_id, room_id, start_time, end_time, title, attendees) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, input.roomId, input.start, input.end, input.title, input.attendees]
      );
      return {
        ok: true,
        reservation: { ...result.rows[0], room_name: room.name },
      };
    });
  }
  return withTransaction(pool, async (client) => {
    const existing = (
      await client.query(
        `SELECT room_id FROM ${reservations} WHERE reservation_id = $1`,
        [input.reservationId]
      )
    ).rows[0];
    if (!existing)
      return {
        ok: true,
        cancelled: false,
        reservation_id: input.reservationId,
      };
    await client.query(
      `UPDATE ${guards} SET version = version + 1 WHERE room_id = $1`,
      [existing.room_id]
    );
    const result = await client.query(
      `DELETE FROM ${reservations} WHERE reservation_id = $1 RETURNING reservation_id`,
      [input.reservationId]
    );
    return {
      ok: true,
      cancelled: result.rowCount === 1,
      reservation_id: input.reservationId,
    };
  });
}

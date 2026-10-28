import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ToolName } from '../apps/mcp-tools/src/booking.js';
export interface Reservation {
  reservation_id: string;
  room_id: string;
  title: string;
  start_time: string;
  end_time: string;
  attendees: number;
}
export interface Result {
  ok: boolean;
  rooms?: { room_id: string; capacity: number }[];
  reservations?: Reservation[];
  reservation?: Reservation;
  cancelled?: boolean;
  error?: { code: string; message: string };
}
export type Invoke = (
  name: ToolName,
  args: Record<string, unknown>
) => Promise<Result>;
export async function runBookingScenario(
  invoke: Invoke,
  date: string,
  observe?: (phase: string, reservation?: Reservation) => Promise<void>
) {
  const prefix = `検証-${randomUUID().slice(0, 8)}`;
  const evidence: Record<string, unknown> = {
    date,
    timezone: 'Asia/Tokyo',
    titlePrefix: prefix,
  };
  const period = {
    start_time: `${date}T14:00:00+09:00`,
    end_time: `${date}T15:00:00+09:00`,
    attendees: 4,
  };
  const search = () => invoke('search_available_rooms', period);
  const list = () => invoke('list_reservations', { date });
  const cancel = (id: string) =>
    invoke('cancel_reservation', { reservation_id: id });
  try {
    const initial = await search();
    assert.equal(initial.ok, true);
    assert(initial.rooms?.some((room) => room.room_id === 'room-kaede'));
    assert(initial.rooms?.every((room) => room.capacity >= 4));
    assert(
      !initial.rooms?.some((room) => room.room_id === 'room-aoba'),
      '既存予約のある部屋が候補に含まれる'
    );
    evidence.initialRooms = initial.rooms;
    const create = await invoke('create_reservation', {
      ...period,
      room_id: 'room-kaede',
      title: `${prefix}-設計レビュー`,
    });
    assert.equal(create.ok, true);
    assert(create.reservation);
    const reservation = create.reservation;
    evidence.reservation = reservation;
    await observe?.('created', reservation);
    const listed = await list();
    assert(
      listed.reservations?.some(
        (row) =>
          row.reservation_id === reservation.reservation_id &&
          row.title === reservation.title
      )
    );
    assert(
      !(await search()).rooms?.some((room) => room.room_id === 'room-kaede')
    );
    const overlap = await invoke('create_reservation', {
      ...period,
      start_time: `${date}T14:30:00+09:00`,
      end_time: `${date}T15:30:00+09:00`,
      room_id: 'room-kaede',
      title: `${prefix}-重複`,
    });
    assert.equal(overlap.error?.code, 'ROOM_UNAVAILABLE');
    evidence.overlapRejected = overlap;
    const adjacent = await invoke('search_available_rooms', {
      ...period,
      start_time: period.end_time,
      end_time: `${date}T16:00:00+09:00`,
    });
    assert(adjacent.rooms?.some((room) => room.room_id === 'room-kaede'));
    const capacity = await invoke('create_reservation', {
      ...period,
      room_id: 'room-sakura',
      title: `${prefix}-定員超過`,
    });
    assert.equal(capacity.error?.code, 'CAPACITY_EXCEEDED');
    evidence.capacityRejected = capacity;
    assert.equal((await cancel(reservation.reservation_id)).cancelled, true);
    assert.equal((await cancel(reservation.reservation_id)).cancelled, false);
    assert(
      (await search()).rooms?.some((room) => room.room_id === 'room-kaede')
    );
    assert(
      !(await list()).reservations?.some(
        (row) => row.reservation_id === reservation.reservation_id
      )
    );
    await observe?.('cancelled', reservation);
    const competing = await Promise.all(
      [1, 2].map((n) =>
        invoke('create_reservation', {
          ...period,
          room_id: 'room-kaede',
          title: `${prefix}-同時予約${n}`,
        })
      )
    );
    // finallyでこの実行が作った予約をすべて回収する。
    assert.equal(
      competing.filter((result) => result.ok).length,
      1,
      '同時予約の成功数が1ではない'
    );
    assert.equal(
      competing.filter((result) => result.error?.code === 'ROOM_UNAVAILABLE')
        .length,
      1
    );
    const winner = competing.find((result) => result.ok)!.reservation!;
    evidence.concurrentBooking = competing;
    await observe?.('concurrent', winner);
    await cancel(winner.reservation_id);
    evidence.completed = true;
    return evidence;
  } finally {
    const remaining = await list();
    assert.equal(remaining.ok, true);
    for (const reservation of remaining.reservations ?? []) {
      if (reservation.title.startsWith(prefix))
        await cancel(reservation.reservation_id);
    }
    await observe?.('cleanup');
  }
}

export const TOOL_NAMES = [
  'search_available_rooms',
  'create_reservation',
  'list_reservations',
  'cancel_reservation',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export class BookingError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export type BookingInput =
  | {
      tool: 'search_available_rooms';
      start: string;
      end: string;
      attendees: number;
    }
  | {
      tool: 'create_reservation';
      start: string;
      end: string;
      attendees: number;
      roomId: string;
      title: string;
    }
  | { tool: 'list_reservations'; start: string; end: string; date: string }
  | { tool: 'cancel_reservation'; reservationId: string };
function invalid(message: string): never {
  throw new BookingError('INVALID_ARGUMENT', message);
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string')
    invalid('日時にはタイムゾーン付きISO 8601形式を指定してください。');
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match) invalid('日時の例: 2026-10-29T14:00:00+09:00');
  const local = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  const zone = match[5];
  if (
    !Number.isFinite(local.getTime()) ||
    local.toISOString().slice(0, 19) !== value.slice(0, 19) ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 14 ||
        Number(zone.slice(4, 6)) > 59 ||
        (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4, 6)) !== 0)))
  )
    invalid('存在する日時とタイムゾーンを指定してください。');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid('日時が不正です。');
  return date.toISOString();
}
export function parseInput(tool: string, event: unknown): BookingInput {
  if (!TOOL_NAMES.includes(tool as ToolName)) invalid('未知のツールです。');
  if (!event || typeof event !== 'object' || Array.isArray(event))
    invalid('引数はオブジェクトで指定してください。');
  const args = event as Record<string, unknown>;
  const keys: Record<ToolName, string[]> = {
    search_available_rooms: ['start_time', 'end_time', 'attendees'],
    create_reservation: [
      'room_id',
      'start_time',
      'end_time',
      'attendees',
      'title',
    ],
    list_reservations: ['date'],
    cancel_reservation: ['reservation_id'],
  };
  if (Object.keys(args).some((key) => !keys[tool as ToolName].includes(key)))
    invalid('未定義の引数は指定できません。');
  if (tool === 'cancel_reservation') {
    if (
      typeof args.reservation_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        args.reservation_id
      )
    )
      invalid('reservation_idには予約時に返されたUUIDを指定してください。');
    return { tool, reservationId: args.reservation_id };
  }
  if (tool === 'list_reservations') {
    if (typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date))
      invalid('dateはAsia/Tokyoの日付をYYYY-MM-DDで指定してください。');
    const start = timestamp(`${args.date}T00:00:00+09:00`);
    return {
      tool,
      date: args.date,
      start,
      end: new Date(Date.parse(start) + 86_400_000).toISOString(),
    };
  }
  const start = timestamp(args.start_time),
    end = timestamp(args.end_time);
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > 86_400_000)
    invalid('終了は開始より後、予約時間は24時間以内で指定してください。');
  if (
    typeof args.attendees !== 'number' ||
    !Number.isInteger(args.attendees) ||
    args.attendees < 1 ||
    args.attendees > 50
  )
    invalid('attendeesは1〜50の整数で指定してください。');
  if (tool === 'search_available_rooms')
    return { tool, start, end, attendees: args.attendees };
  if (
    typeof args.room_id !== 'string' ||
    !/^room-[a-z0-9-]{1,40}$/.test(args.room_id)
  )
    invalid('検索結果のroom_idを指定してください。');
  if (
    typeof args.title !== 'string' ||
    !args.title.trim() ||
    args.title.trim().length > 120
  )
    invalid('titleは1〜120文字で指定してください。');
  return {
    tool: 'create_reservation',
    start,
    end,
    attendees: args.attendees,
    roomId: args.room_id,
    title: args.title.trim(),
  };
}

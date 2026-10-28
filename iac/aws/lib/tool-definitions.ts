import type { CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
type Schema = CfnGatewayTarget.SchemaDefinitionProperty;
const time: Schema = {
  type: 'string',
  description:
    'ISO 8601 timestamp with timezone and seconds, e.g. 2026-10-29T14:00:00+09:00. Interpret relative dates in Asia/Tokyo.',
};
const period = {
  start_time: time,
  end_time: {
    ...time,
    description: `${time.description} End is exclusive, later than start, at most 24 hours later.`,
  },
  attendees: { type: 'integer', description: 'Number of attendees, 1 to 50.' },
};
export const toolDefinitions: CfnGatewayTarget.ToolDefinitionProperty[] = [
  {
    name: 'search_available_rooms',
    description:
      'Read only. Find available fictional meeting rooms by start/end time and attendee count. Does not create reservations. Use the returned room_id for booking.',
    inputSchema: {
      type: 'object',
      properties: period,
      required: ['start_time', 'end_time', 'attendees'],
    },
  },
  {
    name: 'create_reservation',
    description:
      'Write operation. Confirm a booking and persist it to the demo database. Ask the user to confirm room, time, attendee count, and title before calling. Returns reservation_id on success. Overlapping bookings are rejected. Check ok and error before reporting success.',
    inputSchema: {
      type: 'object',
      properties: {
        ...period,
        room_id: {
          type: 'string',
          description: 'room_id from search_available_rooms.',
        },
        title: {
          type: 'string',
          description:
            'Fictional meeting title, 1 to 120 characters. Do not enter personal or confidential information.',
        },
      },
      required: ['room_id', 'start_time', 'end_time', 'attendees', 'title'],
    },
  },
  {
    name: 'list_reservations',
    description:
      'Read only. List reservations overlapping a calendar day in Asia/Tokyo, including meeting room, time, title, and reservation_id. Does not modify data.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Calendar date in Asia/Tokyo, YYYY-MM-DD.',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'cancel_reservation',
    description:
      'Destructive write operation. Delete only the booking identified by reservation_id. Ask the user to confirm the specific reservation before calling. Repeating a cancellation is safe and returns cancelled: false if already absent.',
    inputSchema: {
      type: 'object',
      properties: {
        reservation_id: {
          type: 'string',
          description:
            'UUID returned by create_reservation or list_reservations.',
        },
      },
      required: ['reservation_id'],
    },
  },
];

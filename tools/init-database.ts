import { parseArgs } from 'node:util';
import { adminPool, readOutputs } from './database.js';
import { parseInput } from '../apps/mcp-tools/src/booking.js';
const { values } = parseArgs({
  options: {
    outputs: { type: 'string', default: '.local/outputs.json' },
    stack: { type: 'string', default: 'dev-muse-mcp-test' },
    date: { type: 'string' },
  },
});
async function main() {
  const date =
    values.date ??
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(
      new Date(Date.now() + 86400000)
    );
  parseInput('list_reservations', { date });
  const output = await readOutputs(values.outputs, values.stack);
  const pool = adminPool(output);
  const client = await pool.connect();
  try {
    const schema = 'booking_auth';
    const roleArn = output.AuthenticatedToolRoleArn;
    if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn ?? ''))
      throw new Error('Invalid tool IAM role ARN');
    // DSQLではDDLをDMLと混ぜず、各DDLを単独でコミットする。
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    if (
      !(
        await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
          schema,
        ])
      ).rowCount
    )
      await client.query(`CREATE ROLE ${schema} WITH LOGIN`);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.rooms (room_id text PRIMARY KEY, name text NOT NULL, capacity integer NOT NULL)`
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.reservations (reservation_id uuid PRIMARY KEY, room_id text NOT NULL, start_time timestamptz NOT NULL, end_time timestamptz NOT NULL, title text NOT NULL, attendees integer NOT NULL)`
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.booking_guards (room_id text PRIMARY KEY, version bigint NOT NULL)`
    );
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${schema}`);
    await client.query(`GRANT SELECT ON ${schema}.rooms TO ${schema}`);
    await client.query(
      `GRANT SELECT, INSERT, DELETE ON ${schema}.reservations TO ${schema}`
    );
    await client.query(
      `GRANT SELECT, UPDATE ON ${schema}.booking_guards TO ${schema}`
    );
    await client.query(`AWS IAM GRANT ${schema} TO '${roleArn}'`);
    await client.query('BEGIN');
    try {
      for (const [id, name, capacity] of [
        ['room-sakura', 'さくら', 2],
        ['room-kaede', 'かえで', 4],
        ['room-aoba', 'あおば', 8],
      ] as const) {
        await client.query(
          `INSERT INTO ${schema}.rooms VALUES ($1, $2, $3) ON CONFLICT (room_id) DO NOTHING`,
          [id, name, capacity]
        );
        await client.query(
          `INSERT INTO ${schema}.booking_guards VALUES ($1, 0) ON CONFLICT (room_id) DO NOTHING`,
          [id]
        );
      }
      // 日付ごとの固定IDで再実行可能にし、既存予約を消さない。
      await client.query(
        `INSERT INTO ${schema}.reservations VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (reservation_id) DO NOTHING`,
        [
          `00000000-0000-4000-8000-${date.replaceAll('-', '')}0001`,
          'room-aoba',
          `${date}T14:00:00+09:00`,
          `${date}T15:00:00+09:00`,
          'デモ用の既存予約',
          6,
        ]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log(`${schema}: 初期化完了（既存予約を保持）`);
    console.log(`デモ検索: ${date} 14:00–15:00 Asia/Tokyo、4人 → room-kaede`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

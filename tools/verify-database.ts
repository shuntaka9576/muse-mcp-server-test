import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPool } from '../apps/mcp-tools/src/database.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { runBookingScenario, type Result } from './booking-scenario.js';
import { adminPool, readOutputs } from './database.js';
const { values } = parseArgs({
  options: {
    outputs: { type: 'string', default: '.local/outputs.json' },
    stack: { type: 'string', default: 'dev-muse-mcp-test' },
    date: { type: 'string' },
  },
});
async function main() {
  const output = await readOutputs(values.outputs, values.stack);
  const pool = adminPool(output);
  const caller = JSON.parse(
    execFileSync(
      'aws',
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'],
      { encoding: 'utf8' }
    )
  ) as { Arn: string };
  const assumedRole = /^arn:aws:sts::\d{12}:assumed-role\/([^/]+)\//.exec(
    caller.Arn
  );
  const probeArn = assumedRole
    ? (JSON.parse(
        execFileSync(
          'aws',
          [
            'iam',
            'get-role',
            '--role-name',
            assumedRole[1],
            '--query',
            'Role.Arn',
            '--output',
            'json',
            '--no-cli-pager',
          ],
          { encoding: 'utf8' }
        )
      ) as string)
    : caller.Arn;
  if (!/^arn:aws:iam::\d{12}:(role|user)\/[\w+=,.@/-]+$/.test(probeArn))
    throw new Error('Invalid verification IAM ARN');
  const lambda = new LambdaClient({ region: output.Region });
  const date =
    values.date ??
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(
      new Date(Date.now() + 86400000)
    );
  const evidence: Record<string, unknown> = {
    testedAt: new Date().toISOString(),
    date,
    scenarios: {},
    isolation: [],
  };
  try {
    const schema = 'booking_auth';
    const snapshots: unknown[] = [];
    const result = await runBookingScenario(
      async (name, args) => {
        const response = await lambda.send(
          new InvokeCommand({
            FunctionName: output.AuthenticatedToolFunctionName,
            ClientContext: Buffer.from(
              JSON.stringify({
                custom: { bedrockAgentCoreToolName: `booking___${name}` },
              })
            ).toString('base64'),
            Payload: Buffer.from(JSON.stringify(args)),
          })
        );
        if (response.FunctionError)
          throw new Error(
            `${name}: ${response.FunctionError} (${Buffer.from(response.Payload ?? []).toString('utf8')})`
          );
        return JSON.parse(
          Buffer.from(response.Payload ?? []).toString('utf8')
        ) as Result;
      },
      date,
      async (phase, reservation) => {
        const rows = (
          await pool.query(
            `SELECT * FROM ${schema}.reservations ORDER BY reservation_id`
          )
        ).rows;
        if (phase === 'created' || phase === 'concurrent')
          assert(
            rows.some(
              (row) => row.reservation_id === reservation?.reservation_id
            )
          );
        if (phase === 'cancelled')
          assert(
            !rows.some(
              (row) => row.reservation_id === reservation?.reservation_id
            )
          );
        snapshots.push({ phase, rows });
      }
    );
    (evidence.scenarios as Record<string, unknown>)[schema] = {
      ...result,
      snapshots,
    };
    // DSQLはSET ROLE非対応。管理権限を持つ実行者を一時マッピングし、通常DBロールで接続する。
    const mappings = (
      await pool.query('SELECT arn, pg_role_name FROM sys.iam_pg_role_mappings')
    ).rows;
    const alreadyMapped = mappings.some(
      (row) => row.arn === probeArn && row.pg_role_name === schema
    );
    const probe = createPool(output.DatabaseEndpoint, output.Region, schema);
    try {
      if (!alreadyMapped)
        await pool.query(`AWS IAM GRANT ${schema} TO '${probeArn}'`);
      await probe.query(`SELECT * FROM ${schema}.rooms`);
      const sql = `INSERT INTO ${schema}.rooms SELECT 'forbidden', 'forbidden', 1 WHERE false`;
      let code: string | undefined;
      try {
        await probe.query(sql);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      assert.equal(code, '42501', `期待した権限拒否になりません: ${sql}`);
      (evidence.isolation as unknown[]).push({
        role: schema,
        sql,
        sqlState: code,
        method:
          'Direct connection as database role with temporary operator IAM mapping',
      });
    } finally {
      await probe.end();
      if (!alreadyMapped)
        await pool.query(`AWS IAM REVOKE ${schema} FROM '${probeArn}'`);
    }
    console.log(`${schema}: 予約・取消・同時予約・DSQL照合・権限 OK`);
    evidence.iamRoleMappings = (
      await pool.query('SELECT arn, pg_role_name FROM sys.iam_pg_role_mappings')
    ).rows;
    assert.deepEqual(
      (evidence.iamRoleMappings as { arn: string; pg_role_name: string }[])
        .filter((row) => row.pg_role_name === schema)
        .map((row) => row.arn),
      [output.AuthenticatedToolRoleArn],
      '一時マッピングが残っている、または別のIAMロールに紐づいている'
    );
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/result-database.json',
      JSON.stringify(evidence, null, 2) + '\n'
    );
  } finally {
    lambda.destroy();
    await pool.end();
  }
}
main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

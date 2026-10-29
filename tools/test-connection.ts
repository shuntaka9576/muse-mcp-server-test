import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './oauth.js';
import { runBookingScenario, type Result } from './booking-scenario.js';
import { TOOL_NAMES } from '../apps/mcp-tools/src/booking.js';

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    outputs: { type: 'string', default: '.local/outputs.json' },
    stack: { type: 'string', default: 'dev-muse-mcp-test' },
  },
});

async function main(): Promise<void> {
  const allOutputs = JSON.parse(
    await readFile(values.outputs!, 'utf8')
  ) as Record<string, Record<string, string>>;
  const output = allOutputs[values.stack!];
  if (!output) throw new Error(`出力ファイルに ${values.stack} がありません。`);
  for (const key of [
    'AuthenticatedGatewayUrl',
    'AuthorizationEndpoint',
    'TokenEndpoint',
    'ClientId',
    'Scope',
    'LocalCallbackUrl',
  ]) {
    if (!output[key]) throw new Error(`CDKの出力に ${key} がありません。`);
  }
  const gatewayUrl = new URL(output.AuthenticatedGatewayUrl);
  const checks: Record<string, unknown> = {};

  async function assertDenied(
    label: string,
    token?: string
  ): Promise<Response> {
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'booking___list_reservations',
          arguments: { date: values.date ?? '2026-10-29' },
        },
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    checks[label] = {
      status: response.status,
      method: 'tools/call',
      tool: 'booking___list_reservations',
      challenge: response.headers.get('www-authenticate'),
    };
    await response.body?.cancel();
    if (response.status !== 401 && response.status !== 403) {
      throw new Error(
        `${label}: 認証エラーを期待しましたが HTTP ${response.status} でした。`
      );
    }
    console.log(`${label}: HTTP ${response.status}`);
    return response;
  }

  const unauthorized = await assertDenied('noToken');
  await assertDenied('invalidToken', 'invalid-token');
  const metadataUrl = unauthorized.headers
    .get('www-authenticate')
    ?.match(/resource_metadata="([^"]+)"/)?.[1];
  if (metadataUrl) {
    const url = new URL(metadataUrl);
    if (url.origin !== gatewayUrl.origin)
      throw new Error('resource_metadataの接続先がGatewayと異なります。');
    const metadata = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!metadata.ok)
      throw new Error(
        `保護リソースメタデータを取得できません: HTTP ${metadata.status}`
      );
    checks.protectedResourceMetadata = await metadata.json();
  } else {
    checks.protectedResourceMetadata =
      'WWW-Authenticate に resource_metadata がありませんでした。';
  }
  const tokens = await login({
    authorizationEndpoint: output.AuthorizationEndpoint,
    tokenEndpoint: output.TokenEndpoint,
    clientId: output.ClientId,
    scope: output.Scope,
    callbackUrl: output.LocalCallbackUrl,
  });
  await assertDenied('idToken', tokens.idToken);
  const accessToken = tokens.accessToken;

  const client = new Client({ name: 'muse-mcp-server-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(gatewayUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
    },
  });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    for (const name of TOOL_NAMES) {
      if (!tools.some((tool) => tool.name === `booking___${name}`))
        throw new Error(`tools/list に ${name} がありません。`);
    }
    if (tools.length !== 4) throw new Error('公開ツールが4つではありません。');
    const date =
      values.date ??
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(
        new Date(Date.now() + 86400000)
      );
    const result = await runBookingScenario(async (name, args) => {
      const result = await client.callTool({
        name: `booking___${name}`,
        arguments: args,
      });
      if (result.isError)
        throw new Error(`tools/call ${name} がエラーを返しました。`);
      if (
        result.structuredContent &&
        typeof result.structuredContent === 'object' &&
        'ok' in result.structuredContent
      )
        return result.structuredContent as unknown as Result;
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text') {
            const parsed = JSON.parse(item.text) as Result;
            if (typeof parsed.ok === 'boolean') return parsed;
          }
        }
      }
      throw new Error(`${name}: 予約ツールのJSON応答がありません。`);
    }, date);
    await mkdir('.local', { recursive: true });
    const resultPath = '.local/result-authenticated.json';
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          gatewayUrl: gatewayUrl.href,
          checks,
          server: client.getServerVersion(),
          tools,
          result,
        },
        null,
        2
      ) + '\n'
    );
    console.log(
      `initialize / tools/list / 会議室予約・取消・同時予約テスト 成功\n結果: ${resultPath}`
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  // SDKのエラーオブジェクト全体にはリクエスト情報が含まれ得るため表示しない。
  console.error(
    error instanceof Error ? error.message : '接続テストに失敗しました。'
  );
  process.exitCode = 1;
});

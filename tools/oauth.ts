import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

export interface OAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
  callbackUrl: string;
}

export function createAuthorizationRequest(config: OAuthConfig) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: `openid ${config.scope}`,
    state,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return { url, verifier, state };
}

export function readAuthorizationCode(url: URL, expectedState: string): string {
  if (url.searchParams.get('state') !== expectedState)
    throw new Error('OAuth state mismatch');
  if (url.searchParams.has('error'))
    throw new Error('Cognito authorization was denied');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Missing authorization code');
  return code;
}

/** ローカル検証用。Cognitoへ直接ログインし、トークンはメモリ内だけで扱う。 */
export async function login(
  config: OAuthConfig
): Promise<{ accessToken: string; idToken: string }> {
  const callback = new URL(config.callbackUrl);
  if (callback.href !== 'http://localhost:8765/callback') {
    throw new Error(
      'ローカル検証のcallbackは http://localhost:8765/callback を使用します。'
    );
  }
  const request = createAuthorizationRequest(config);
  const server = createServer();
  server.listen(8765, '127.0.0.1');
  await once(server, 'listening');

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(new Error('Cognitoログインが5分以内に完了しませんでした。')),
        300_000
      );
      server.on('request', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (req.method !== 'GET' || req.headers.host !== callback.host) {
          res.writeHead(400).end('Invalid callback');
          return;
        }
        const url = new URL(req.url ?? '/', callback.origin);
        if (url.pathname !== callback.pathname) {
          res.writeHead(404).end('Not found');
          return;
        }
        try {
          const code = readAuthorizationCode(url, request.state);
          res.end('認可コードを受け取りました。ターミナルに戻ってください。');
          resolve(code);
        } catch {
          res.writeHead(400).end('Invalid authorization response');
          // 異なるstateのアクセスで、進行中のログインを終了させない。
          if (url.searchParams.get('state') === request.state)
            reject(new Error('Cognitoの認可に失敗しました。'));
        }
      });
      console.log(
        `次のURLをブラウザで開き、Cognitoにログインしてください:\n${request.url.href}`
      );
    });

    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        code,
        code_verifier: request.verifier,
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`トークン交換に失敗しました: HTTP ${response.status}`);
    const tokens = (await response.json()) as Record<string, unknown>;
    if (
      typeof tokens.access_token !== 'string' ||
      typeof tokens.id_token !== 'string'
    ) {
      throw new Error(
        'Cognitoからaccess_tokenまたはid_tokenが返りませんでした。'
      );
    }
    return { accessToken: tokens.access_token, idToken: tokens.id_token };
  } finally {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }
}

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuthorizationRequest, readAuthorizationCode } from './oauth.js';

describe('ローカルOAuthクライアント', () => {
  it('S256チャレンジと毎回異なるstate・verifierを生成する', () => {
    const config = {
      authorizationEndpoint: 'https://example.com/oauth2/authorize',
      tokenEndpoint: 'https://example.com/oauth2/token',
      clientId: 'test',
      scope: 'test/invoke',
      callbackUrl: 'http://localhost:8765/callback',
    };
    const first = createAuthorizationRequest(config);
    const second = createAuthorizationRequest(config);
    expect(first.state).not.toEqual(second.state);
    expect(first.verifier).not.toEqual(second.verifier);
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(first.url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(first.verifier).digest('base64url')
    );
    expect(first.url.searchParams.get('scope')).toBe('openid test/invoke');
    expect(first.url.searchParams.has('client_secret')).toBe(false);
    expect(first.url.searchParams.has('code_verifier')).toBe(false);
  });

  it('stateが一致した認可コードだけを受け付ける', () => {
    expect(
      readAuthorizationCode(
        new URL('http://localhost/callback?state=expected&code=code'),
        'expected'
      )
    ).toBe('code');
    expect(() =>
      readAuthorizationCode(
        new URL('http://localhost/callback?state=wrong&code=code'),
        'expected'
      )
    ).toThrow('state');
    expect(() =>
      readAuthorizationCode(
        new URL('http://localhost/callback?code=code'),
        'expected'
      )
    ).toThrow('state');
    expect(() =>
      readAuthorizationCode(
        new URL('http://localhost/callback?state=expected&error=access_denied'),
        'expected'
      )
    ).toThrow('denied');
    expect(() =>
      readAuthorizationCode(
        new URL('http://localhost/callback?state=expected'),
        'expected'
      )
    ).toThrow('Missing');
  });
});

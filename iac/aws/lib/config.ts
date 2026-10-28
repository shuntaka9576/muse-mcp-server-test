export const LOCAL_CALLBACK_URL = 'http://localhost:8765/callback';

export interface Config {
  stageName: string;
  prefix: string;
  region: string;
  callbackUrls: string[];
}

/** CDK context から検証環境の設定を読む。アカウントIDは固定しない。 */
export function getConfig(context: {
  stageName?: unknown;
  region?: unknown;
  additionalCallbackUrls?: unknown;
}): Config {
  const stageName = context.stageName ?? 'dev';
  if (
    typeof stageName !== 'string' ||
    !/^[a-z][a-z0-9]{0,11}$/.test(stageName)
  ) {
    throw new Error(
      'stageName は英小文字で始まる英小文字・数字12文字以内です。'
    );
  }
  const region = context.region ?? 'ap-northeast-1';
  if (typeof region !== 'string' || !/^[a-z]{2}-[a-z]+-\d+$/.test(region)) {
    throw new Error('region にAWSリージョンを指定してください。');
  }
  const additional = context.additionalCallbackUrls ?? '';
  if (typeof additional !== 'string') {
    throw new Error('additionalCallbackUrls はカンマ区切りのURLです。');
  }
  const callbackUrls = [
    ...new Set([
      LOCAL_CALLBACK_URL,
      ...additional
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ];
  for (const value of callbackUrls) {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && value !== LOCAL_CALLBACK_URL) ||
      url.hash ||
      url.username ||
      url.password ||
      value.includes('*')
    ) {
      throw new Error(
        '追加のコールバックURLには、フラグメントのないHTTPS URLを指定してください。'
      );
    }
  }
  return {
    stageName,
    prefix: `${stageName}-muse-mcp`,
    region,
    callbackUrls,
  };
}

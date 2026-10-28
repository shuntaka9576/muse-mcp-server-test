import { readFile } from 'node:fs/promises';
import { createPool } from '../apps/mcp-tools/src/database.js';
export async function readOutputs(
  path = '.local/outputs.json',
  stack = 'dev-muse-mcp-test'
) {
  const all = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  const output = all[stack];
  if (!output) throw new Error(`出力に ${stack} がありません。`);
  return output;
}
export function adminPool(output: Record<string, string>) {
  if (!output.DatabaseEndpoint || !output.Region)
    throw new Error('DatabaseEndpointとRegionが必要です。');
  return createPool(output.DatabaseEndpoint, output.Region, 'admin');
}

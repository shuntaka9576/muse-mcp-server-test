import { BookingError, parseInput } from './booking.js';
import { bookingSchema, createPool, executeBooking } from './database.js';
let pool: ReturnType<typeof createPool> | undefined;
interface GatewayContext {
  awsRequestId?: string;
  callbackWaitsForEmptyEventLoop?: boolean;
  clientContext?: { custom?: Record<string, string> };
}
export async function handler(
  event: unknown,
  context: GatewayContext
): Promise<Record<string, unknown>> {
  context.callbackWaitsForEmptyEventLoop = false;
  const tool =
    context.clientContext?.custom?.bedrockAgentCoreToolName
      ?.split('___')
      .at(-1) ?? '';
  try {
    const input = parseInput(tool, event);
    const schema = bookingSchema(process.env.BOOKING_SCHEMA);
    const host = process.env.DSQL_ENDPOINT,
      region = process.env.AWS_REGION,
      user = process.env.DSQL_USER;
    if (!host || !region || !user)
      throw new Error('Missing database configuration');
    pool ??= createPool(host, region, user);
    const result = await executeBooking(pool, schema, input);
    console.info(
      JSON.stringify({
        requestId: context.awsRequestId,
        tool,
        schema,
        input,
        result,
      })
    );
    return result;
  } catch (error) {
    if (error instanceof BookingError) {
      const result = {
        ok: false,
        error: { code: error.code, message: error.message },
      };
      console.info(
        JSON.stringify({ requestId: context.awsRequestId, tool, result })
      );
      return result;
    }
    // SQL本文や認証情報をクライアント・ログに出さない。
    console.error(
      JSON.stringify({
        requestId: context.awsRequestId,
        tool,
        code: (error as { code?: string }).code ?? 'INTERNAL_ERROR',
      })
    );
    throw new Error(
      '予約処理に失敗しました。予約一覧で結果を確認してください。'
    );
  }
}

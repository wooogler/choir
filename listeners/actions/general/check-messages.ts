import { AllMiddlewareArgs, BlockAction, SlackActionMiddlewareArgs } from "@slack/bolt";

/**
 * 메시지 체크 액션 처리
 */
export async function handleCheckMessages({
  ack,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) {
  await ack();
}
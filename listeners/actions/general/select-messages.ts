import { AllMiddlewareArgs, BlockAction, SlackActionMiddlewareArgs } from "@slack/bolt";

/**
 * 체크박스 선택 액션 처리
 */
export async function handleSelectedMessages({
  ack,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) {
  await ack();
}
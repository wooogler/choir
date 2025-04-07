import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import GithubService from "../../services/github";
import { VectorStoreService } from "../../services/index";
import {
  getStoredEditData,
  getStoredMessages,
} from "../../services/slack-utils";

const applyUpdateCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    if (!rawValue) {
      throw new Error("No value provided");
    }

    const { editDataKey } = JSON.parse(rawValue);
    const editData = getStoredEditData(editDataKey);
    if (!editData) {
      throw new Error("No edit data found");
    }

    const { updatedMarkdown, messages, fileName } = editData;

    const subject = "Update document with CHOIR";

    const githubService = GithubService.getInstance();

    console.log("messages", messages);
    const commits = await githubService.getHistoryOfMarkdownUpdate({
      owner: "wooogler",
      repo: "choir_docs",
      path: fileName,
      newContent: updatedMarkdown,
    });

    console.log("commits", commits);

    // await githubService.updateMarkdownFile({
    //   owner: "wooogler",
    //   repo: "choir_docs",
    //   path: editData.fileName,
    //   content: updatedMarkdown,
    //   message: `${subject}\n\n${JSON.stringify(messages)}`,
    // });

    await client.chat.postMessage({
      channel: body.channel?.id ?? "",
      thread_ts: body.container.thread_ts,
      text: "✅ Document has been updated successfully!",
    });
  } catch (error) {
    console.error(error);
    await client.chat.postMessage({
      channel: body.channel?.id ?? "",
      thread_ts: body.container.thread_ts,
      text: "❌ Failed to update document.",
    });
  }
};

export default applyUpdateCallback;

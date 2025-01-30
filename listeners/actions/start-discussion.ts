import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";

const startDiscussionCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    console.log("rawValue", rawValue);
    if (!rawValue) {
      throw new Error("No value provided");
    }
    const value = JSON.parse(rawValue);
    const { authors, fileName, githubUrl } = value;
    const uniqueAuthors = Array.from(new Set(authors)) as string[];

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        private_metadata: JSON.stringify({
          authors: uniqueAuthors,
          fileName,
          githubUrl,
        }),
        title: {
          type: "plain_text",
          text: "Start Discussion",
        },
        submit: {
          type: "plain_text",
          text: "Start",
        },
        blocks: [
          {
            type: "input",
            block_id: "users_block",
            element: {
              type: "multi_users_select",
              action_id: "selected_users",
              initial_users: uniqueAuthors,
              placeholder: {
                type: "plain_text",
                text: "Select users to discuss with",
              },
            },
            label: {
              type: "plain_text",
              text: "Select Users",
            },
          },
        ],
        callback_id: "start_discussion_modal",
      },
    });
  } catch (error) {
    console.error(error);
  }
};

export default startDiscussionCallback;

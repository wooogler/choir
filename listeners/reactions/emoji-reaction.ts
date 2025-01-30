import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";

const emojiReactionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"reaction_added">) => {
  if (event.reaction !== "writing_hand") {
    return;
  }

  await client.chat.postMessage({
    channel: event.item.channel,
    thread_ts: event.item.ts,
    text: "Saved!",
  });

  await client.chat.postEphemeral({
    channel: event.item.channel,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "CHOIR detects messages to update team's documents.",
        },
      },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Detected Messages",
          emoji: true,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "image",
            image_url:
              "https://pbs.twimg.com/profile_images/625633822235693056/lNGUneLX_400x400.jpg",
            alt_text: "cat profile",
          },
          {
            type: "mrkdwn",
            text: "*Sangwook* - Good Morning!",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "image",
            image_url:
              "https://i.pinimg.com/736x/04/8b/8d/048b8dbc061a104f266176b1b7bf828c.jpg",
            alt_text: "dog profile",
          },
          {
            type: "mrkdwn",
            text: "*Sang* - I update lab's wifi password to '12345678'",
          },
        ],
      },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Document Updates",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Document: <https://www.google.com|Lab Resources>",
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: "*Password* (Old)\nWifi password: ~abcdefg~",
          },
          {
            type: "mrkdwn",
            text: "*Password* (New)\nWifi password: 12345678",
          },
        ],
      },
      {
        type: "input",
        element: {
          type: "plain_text_input",
          multiline: true,
          action_id: "plain_text_input-action",
          initial_value: "Sang updates Wifi password on Jan 19",
        },
        label: {
          type: "plain_text",
          text: "Context",
          emoji: true,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              emoji: true,
              text: "Update",
            },
            confirm: {
              title: {
                type: "plain_text",
                text: "Are you sure?",
              },
              text: {
                type: "mrkdwn",
                text: "Do you want to update the document?",
              },
              confirm: {
                type: "plain_text",
                text: "Yes",
              },
              deny: {
                type: "plain_text",
                text: "No",
              },
            },
            style: "primary",
            value: "click_me_123",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              emoji: true,
              text: "Create a New Section",
            },
            value: "click_new_section",
          },
        ],
      },
    ],
    user: event.user,
    thread_ts: event.item.ts,
  });
};

export default emojiReactionCallback;

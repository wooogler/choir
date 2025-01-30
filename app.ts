import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";
import registerListeners from "./listeners";
import GithubService from "./services/github";
import VectorStoreService from "./services/vector-store";

dotenv.config();

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
});

const githubService = GithubService.getInstance();
const vectorStore = VectorStoreService.getInstance();

/** Register Listeners */
registerListeners(app);

/** Start Bolt App */
(async () => {
  try {
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner: "wooogler",
      repo: "choir_docs",
      path: "",
    });

    await vectorStore.setMarkdownFiles(markdownFiles);

    await app.start(process.env.PORT || 3000);
    app.logger.info("⚡️ Bolt app is running! ⚡️");
  } catch (error) {
    app.logger.error("Unable to start App", error);
  }
})();

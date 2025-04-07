import type { App } from "@slack/bolt";
import actions from "./actions";
import commands from "./commands";
import events from "./events";
import messages from "./messages";
import shortcuts from "./shortcuts";
import views from "./views";
import dms from "./dms";
import reactions from "./reactions";
import mentions from "./mentions";

const registerListeners = (app: App) => {
  // 모든 리스너 등록
  actions.register(app);
  commands.register(app);
  events.register(app);
  messages.register(app);
  shortcuts.register(app);
  views.register(app);
  dms.register(app);
  reactions.register(app);
  mentions.register(app);
};

export default registerListeners;

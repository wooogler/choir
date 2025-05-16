import type { App } from "@slack/bolt";
import actions from "./actions";
import appHome from "./app-home";
import views from "./views";
import mentions from "./mentions";
import dms from "./dms";

const registerListeners = (app: App) => {
  // 모든 리스너 등록
  actions.register(app);
  appHome.register(app);
  views.register(app);
  mentions.register(app);
  dms.register(app);
};

export default registerListeners;

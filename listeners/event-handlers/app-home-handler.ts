import type { App } from '@slack/bolt';
import { register as registerAppHomeFeature } from '../features/app-home';

const register = (app: App) => {
  registerAppHomeFeature(app);
};

export default { register };
export { appHomeOpenedCallback } from '../features/app-home/home-event-handler';

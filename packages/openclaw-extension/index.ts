import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { wechatPlugin } from "./src/channel.js";
import { setWeChatRuntime } from "./src/runtime.js";
import { OPENCLAW_CHANNEL_ID } from "./src/types.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: OPENCLAW_CHANNEL_ID,
  name: "WeChat",
  description: "WeChat channel via agent-wechat container",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWeChatRuntime(api.runtime);
    api.registerChannel({ plugin: wechatPlugin });
  },
};

export default plugin;

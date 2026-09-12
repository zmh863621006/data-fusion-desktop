import { DefaultPluginRegistry } from '../core/plugins/types';
import { mockMarketPlugin } from '../plugins/mock-market';

export class AppRuntime {
  readonly plugins = new DefaultPluginRegistry();

  async initialize(): Promise<void> {
    this.plugins.register(mockMarketPlugin);

    for (const plugin of this.plugins.list()) {
      await plugin.initialize();
    }
  }
}

export const appRuntime = new AppRuntime();

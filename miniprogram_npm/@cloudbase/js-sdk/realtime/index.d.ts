import { ICloudbase } from '@cloudbase/js-sdk/types';
import { RealtimeWebSocketClient } from './websocket-client';
export declare function registerRealtime(app: Pick<ICloudbase, 'registerComponent' | 'registerHook'>): void;
export { RealtimeWebSocketClient };

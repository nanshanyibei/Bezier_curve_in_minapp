import { ICloudbase } from '@cloudbase/js-sdk/types';
declare function getEntity(cloudbase: any): import("@cloudbase/wx-cloud-client-sdk").OrmClient;
export declare function lazyGetEntity(cloudbase: ICloudbase): ReturnType<typeof getEntity>;
export declare function registerModel(app: ICloudbase): void;
export * from '@cloudbase/wx-cloud-client-sdk';

import { ICloudbase } from '@cloudbase/js-sdk/types';
import { ICallContainerOptions, IContianerConfig } from '@cloudbase/js-sdk/types/container';
export declare let t: (str: any) => any;
export declare class CloudbaseContainers {
    private readonly config;
    private wasm;
    private containerInitPromise;
    private defaultHeaders;
    constructor(config: IContianerConfig);
    callContainer(options: ICallContainerOptions, callback?: Function): Promise<any>;
    initContainer(config: Omit<IContianerConfig, 'wasmUrl' | 'jsUrl'>): Promise<any>;
}
export declare function registerContainers(app: Pick<ICloudbase, 'registerComponent'>): void;

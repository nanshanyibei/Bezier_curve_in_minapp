import { ICloudbase } from '@cloudbase/js-sdk/types';
import { ICallFunctionOptions, ICustomReqOpts } from '@cloudbase/js-sdk/types/functions';
export declare function requestContainer(this: any, options: ICallFunctionOptions, customReqOpts?: ICustomReqOpts): Promise<any>;
export declare function registerCloudrun(app: Pick<ICloudbase, 'registerComponent'>): void;

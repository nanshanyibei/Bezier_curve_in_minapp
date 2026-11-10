import { ICloudbase } from '@cloudbase/js-sdk/types';
import { StorageFileApi } from './storage-file-api-neo';
import { StorageBucketApi } from './storage-bucket-api-neo';
import { ClassicStorageFileApi } from './storage-file-api-classic';
export { COMPONENT_NAME, CloudbaseStorage } from './cloudbase-storage';
export type { ICloudbaseContext } from './cloudbase-storage';
export { ClassicStorageFileApi } from './storage-file-api-classic';
export { StorageFileApi } from './storage-file-api-neo';
export declare class StorageClient extends StorageBucketApi {
    from(): ClassicStorageFileApi;
    from<const B extends string>(bucketId: B): StorageFileApi;
}
export declare function registerStorage(app: Pick<ICloudbase, 'registerComponent'>): void;

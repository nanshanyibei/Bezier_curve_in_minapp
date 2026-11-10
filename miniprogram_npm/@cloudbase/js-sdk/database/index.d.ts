import { ICloudbase } from '@cloudbase/js-sdk/types';
import cloudbaseNS from '../../index';
declare type QueryType = 'WHERE' | 'DOC';
interface IDbConfig {
    instance?: string;
    database?: string;
}
interface IBaseReq extends IDbConfig {
    collectionName: string;
    transactionId?: string;
}
interface IDocumentsQueryReq extends IBaseReq {
    query?: any;
    queryType?: QueryType;
    order?: Record<string, any> | {
        field: string;
        direction: string;
    }[] | string;
    offset?: number;
    limit?: number;
    projection?: Object;
}
interface IDocumentsAddReq extends IBaseReq {
    data: Object | Object[];
}
interface IDocumentsUpdateReq extends IBaseReq {
    query: Object;
    data: Object;
    multi?: boolean;
    merge?: boolean;
    upsert?: boolean;
    replaceMode?: boolean;
    queryType?: QueryType;
}
interface IDocumentsRemoveReq extends IBaseReq {
    query: Object;
    multi?: boolean;
    queryType?: QueryType;
}
interface IDocumentsCountReq extends IBaseReq {
    query: Object;
    queryType?: QueryType;
}
interface ICommonRes<T> {
    data?: T & {
        code?: string;
    };
    requestId: string;
    code?: string;
    message?: string;
}
interface IAddRes {
    _id?: string;
    ids?: string[];
    insertedIds: string[];
}
interface IRunCommandsReq {
    transactionId?: string;
    commands: Object[];
}
export declare const gateWayFunc: {
    filterRes<T>(res: ICommonRes<T> & {
        header?: any;
        statusCode?: number;
    }, ctx?: any): ICommonRes<T>;
    normalizeTransactionResponse(res: any, kind: 'start' | 'commit' | 'rollback'): any;
    flattenResData<T_1>(res: ICommonRes<T_1>): any;
    safeParseEJSON(data: any): any;
    parseEJSONParam(value: any): any;
    parseEJSONValue(value: any): any;
    normalizeOrderParam(value: any): any;
    extractDocId(query: any): string | undefined;
    toLegacyRegExp(value: any): any;
    parseWriteParam(value: any): any;
    buildQueryParams(params: Record<string, any>): string;
    getUrlPrefix(data: IDbConfig): string;
    'database.queryDocument'(data: IDocumentsQueryReq, customReqOpts?: any): Promise<ICommonRes<{
        offset?: number;
        limit?: number;
        list: any[];
    }>>;
    'database.addDocument'(data: IDocumentsAddReq, customReqOpts?: any): Promise<ICommonRes<IAddRes>>;
    'database.updateDocument'(data: IDocumentsUpdateReq, customReqOpts?: any): Promise<ICommonRes<{
        matched: number;
        updated: number;
        upsert_id: string;
    }>>;
    'database.deleteDocument'(data: IDocumentsRemoveReq, customReqOpts?: any): Promise<ICommonRes<{
        deleted: number;
    }>>;
    'database.countDocument'(data: IDocumentsCountReq, customReqOpts?: any): Promise<ICommonRes<{
        total: number;
    }>>;
    'database.addCollection'(data: {
        collectionName: string;
    } & IDbConfig, customReqOpts?: any): Promise<ICommonRes<''>>;
    'database.aggregate'(data: {
        collectionName: string;
        stages: {
            stageKey: string;
            stageValue: any;
        }[];
    } & IDbConfig, customReqOpts?: any): Promise<ICommonRes<{
        list: string;
    }>>;
    'database.startTransaction'(data: IDbConfig, customReqOpts?: any): Promise<any>;
    'database.commitTransaction'(data: {
        transactionId: string;
    } & IDbConfig, customReqOpts?: any): Promise<any>;
    'database.abortTransaction'(data: {
        transactionId: string;
    } & IDbConfig, customReqOpts?: any): Promise<any>;
    'database.getInTransaction'(data: IDocumentsQueryReq, customReqOpts?: any): Promise<any>;
    'database.updateDocInTransaction'(data: IDocumentsUpdateReq, customReqOpts?: any): Promise<any>;
    'database.deleteDocInTransaction'(data: IDocumentsRemoveReq, customReqOpts?: any): Promise<any>;
    'database.insertDocInTransaction'(data: IDocumentsAddReq, customReqOpts?: any): Promise<ICommonRes<IAddRes & {
        inserted?: number;
    }>>;
    'database.runCommands'(data: IRunCommandsReq & IDbConfig, customReqOpts?: any): Promise<ICommonRes<{
        list: Object[][];
    }>>;
    'database.getDocument'(data: IDocumentsQueryReq, customReqOpts?: any): Promise<ICommonRes<{
        offset?: number;
        limit?: number;
        list: any[];
    }>>;
    'database.insertDocument'(data: IDocumentsAddReq, customReqOpts?: any): Promise<ICommonRes<IAddRes>>;
    'database.modifyDocument'(data: IDocumentsUpdateReq, customReqOpts?: any): Promise<ICommonRes<{
        matched: number;
        updated: number;
        upsert_id: string;
    }>>;
    'database.modifyAndReturnDoc'(data: IDocumentsUpdateReq, customReqOpts?: any): Promise<any>;
    'database.removeDocument'(data: IDocumentsRemoveReq, customReqOpts?: any): Promise<ICommonRes<{
        deleted: number;
    }>>;
    'database.calculateDocument'(data: IDocumentsCountReq, customReqOpts?: any): Promise<ICommonRes<{
        total: number;
    }>>;
    'database.aggregateDocuments'(data: {
        collectionName: string;
        stages: {
            stageKey: string;
            stageValue: any;
        }[];
    } & IDbConfig, customReqOpts?: any): Promise<ICommonRes<{
        list: any;
    }>>;
};
export declare function registerDatabase(app: ICloudbase | typeof cloudbaseNS): void;
export {};

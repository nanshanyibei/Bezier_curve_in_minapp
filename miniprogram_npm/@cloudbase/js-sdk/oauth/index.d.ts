import { OAuth2Client } from './oauth2client/oauth2client';
import { AuthOptions, Auth } from './auth/apis';
import { Credentials } from './oauth2client/models';
export { Auth } from './auth/apis';
export { AuthError, AuthErrorCategory, isAuthError } from './auth/auth-error';
export * as authModels from './auth/models';
export type { ProviderProfile, UserInfo, ModifyUserBasicInfoRequest } from './auth/models';
export type { Credentials, OAuth2ClientOptions, ResponseError, AuthClientRequestOptions } from './oauth2client/models';
export type { AuthOptions } from './auth/apis';
export { weAppJwtDecodeAll } from './utils/base64';
export { AUTH_API_PREFIX, OAUTH_TYPE, DEFAULT_NODE_ACCESS_SCOPE, LOGIN_STATE_CHANGED_TYPE, EVENTS, AUTH_STATE_CHANGED_TYPE, AuthErrorCode, ErrorType, VerificationUsage } from './auth/consts';
export declare class CloudbaseOAuth {
    oauth2client: OAuth2Client;
    authApi: Auth;
    private detectSessionInUrl;
    constructor(authOptions: AuthOptions);
    initializeSession(onUserObtained?: (data: {
        session: Credentials;
        user?: any;
        type?: string;
    }, error?: any) => void | Promise<void>): void;
}

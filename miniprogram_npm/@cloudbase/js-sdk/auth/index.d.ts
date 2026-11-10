import type { ICloudbase, ICloudbaseConfig } from '@cloudbase/js-sdk/types';
import type { ICloudbaseCache } from '@cloudbase/js-sdk/types/cache';
import type { ICloudbaseRequest } from '@cloudbase/js-sdk/types/request';
import type { ICloudbaseAuthConfig, IUser, ILoginState } from '@cloudbase/js-sdk/types/auth';
import type { AuthOptions, Credentials } from '@cloudbase/js-sdk/oauth';
import { CloudbaseOAuth, AuthError, authModels } from '@cloudbase/js-sdk/oauth';
import { CloudbaseEventEmitter } from './utilities';
import { AuthV1Compat, WeixinAuthProvider, CustomAuthProvider, AnonymousAuthProvider } from './v1-compat';
import { AuthOtpResponse, AuthResponse, CommonRes, DeleteMeReq, GetClaimsRes, GetUserIdentitiesRes, GetUserRes, LinkIdentityReq, LinkIdentityRes, OAuthResponse, OnAuthStateChangeCallback, ReauthenticateRes, ResendParams, ResendRes, ResetPasswordForEmailRes, ResetPasswordForOldReq, SetSessionReq, SignInAnonymouslyCredentials, SignInRes, SignInWithIdTokenReq, SignInWithOAuthCredentials, SignInWithPasswordCredentials, SignInWithPasswordlessCredentials, SignUpRes, UnlinkIdentityReq, UpdateUserWithVerificationRes, UserAttributes, UserResponse, VerifyOAuthReq, VerifyOAuthRes, VerifyOtpParams, GetAccessTokenRes } from './type';
export type { AuthResponse, AuthTokenResponsePassword, AuthOtpResponse, UserResponse, OAuthResponse, SignInRes, GetUserRes, CommonRes, SignInWithOtpRes, SignInOAuthRes, GetClaimsRes, ResetPasswordForEmailRes, GetUserIdentitiesRes, LinkIdentityRes, ReauthenticateRes, ResendRes, UpdateUserWithVerificationRes, OnAuthStateChangeCallback, SignInWithPasswordCredentials, SignInWithPasswordlessCredentials, SignUpWithPasswordCredentials, SignInWithOAuthCredentials, SignInAnonymouslyCredentials, VerifyOtpParams, ResendParams, UserAttributes, SignInWithPasswordReq, SignInWithIdTokenReq, SignInWithOAuthReq, VerifyOAuthReq, VerifyOtpReq, LinkIdentityReq, UnlinkIdentityReq, UpdateUserReq, SignInWithOtpReq, ResetPasswordForOldReq, ResendReq, SetSessionReq, DeleteMeReq, SignUpRes, GetAccessTokenRes, AuthResult, } from './type';
interface UserInfo {
    uid?: string;
    gender?: string;
    picture?: string;
    email?: string;
    email_verified?: boolean;
    phone_number?: string;
    username?: string;
    name?: string;
    birthdate?: string;
    zoneinfo?: string;
    locale?: string;
    sub?: string;
    created_from?: string;
}
interface IUserOptions {
    cache: ICloudbaseCache;
    oauthInstance: CloudbaseOAuth;
}
export declare class User implements IUser {
    uid?: string;
    gender?: string;
    picture?: string;
    email?: string;
    emailVerified?: boolean;
    phoneNumber?: string;
    username?: string;
    name?: string;
    providers?: {
        id?: string;
        providerUserId?: string;
        name?: string;
    }[];
    birthdate?: string;
    zoneinfo?: string;
    locale?: string;
    sub?: string;
    createdFrom?: string;
    open_id?: string;
    private cache;
    private oauthInstance;
    constructor(options: IUserOptions);
    checkLocalInfo(): Promise<void>;
    checkLocalInfoAsync(): Promise<void>;
    update(userInfo: authModels.UserProfile): Promise<void>;
    updateUserBasicInfo(params: authModels.ModifyUserBasicInfoRequest): Promise<void>;
    updatePassword(newPassword: string, oldPassword: string): Promise<void>;
    updateUsername(username: string): Promise<void>;
    refresh(params?: {
        version?: string;
        query?: any;
    }): Promise<authModels.UserInfo>;
    getLocalUserInfo(key?: string): string | boolean | Record<string, any>;
    setLocalUserInfo(userInfo: any): void;
    private getLocalUserInfoAsync;
    private setUserInfo;
}
interface ILoginStateOptions extends IUserOptions {
    envId: string;
}
export declare class LoginState implements ILoginState {
    user: User;
    oauthLoginState: any;
    private oauthInstance;
    private cache;
    constructor(options: ILoginStateOptions);
    checkLocalState(): void;
    checkLocalStateAsync(): Promise<void>;
}
interface IAuthConfig extends ICloudbaseAuthConfig {
    cache: ICloudbaseCache;
    request?: ICloudbaseRequest;
    eventBus: CloudbaseEventEmitter;
    runtime?: string;
}
declare class Auth extends AuthV1Compat {
    readonly config: IAuthConfig;
    oauthInstance: CloudbaseOAuth;
    readonly cache: ICloudbaseCache;
    private listeners;
    private hasListenerSetUp;
    constructor(config: IAuthConfig);
    signInAnonymously(params: SignInAnonymouslyCredentials): Promise<AuthResponse>;
    signUp(params: authModels.SignUpRequest & {
        phone?: string;
    }): Promise<SignUpRes>;
    signOut(params?: authModels.SignoutRequest): Promise<authModels.SignoutResponse & {
        data: Object;
        error: AuthError;
    }>;
    onAuthStateChange(callback: OnAuthStateChangeCallback): {
        data: {
            subscription: {
                id: string;
                callback: OnAuthStateChangeCallback;
                unsubscribe: () => void;
            };
        };
    };
    signInWithPassword(params: SignInWithPasswordCredentials): Promise<AuthResponse>;
    signInWithIdToken(params: SignInWithIdTokenReq): Promise<SignInRes>;
    signInWithOtp(params: SignInWithPasswordlessCredentials): Promise<AuthOtpResponse>;
    verifyOAuth(params?: VerifyOAuthReq): Promise<VerifyOAuthRes>;
    signInWithOAuth(params: SignInWithOAuthCredentials): Promise<OAuthResponse>;
    getClaims(): Promise<GetClaimsRes>;
    resetPasswordForEmail(emailOrPhone: string, options?: {
        redirectTo?: string;
    }): Promise<ResetPasswordForEmailRes>;
    resetPasswordForOld(params: ResetPasswordForOldReq): Promise<SignInRes>;
    verifyOtp(params: VerifyOtpParams): Promise<AuthResponse>;
    getSession(): Promise<SignInRes>;
    refreshSession(refresh_token?: string): Promise<SignInRes>;
    getUser(isRefresh?: boolean): Promise<GetUserRes>;
    refreshUser(): Promise<CommonRes>;
    updateUser(params: UserAttributes): Promise<UserResponse | UpdateUserWithVerificationRes>;
    getUserIdentities(): Promise<GetUserIdentitiesRes>;
    linkIdentity(params: LinkIdentityReq): Promise<LinkIdentityRes>;
    unlinkIdentity(params: UnlinkIdentityReq): Promise<CommonRes>;
    reauthenticate(): Promise<ReauthenticateRes>;
    resend(params: ResendParams): Promise<ResendRes>;
    setSession(params: SetSessionReq): Promise<SignInRes>;
    exchangeCodeForSession(): Promise<void>;
    deleteUser(params: DeleteMeReq): Promise<CommonRes>;
    toDefaultLoginPage(params?: authModels.ToDefaultLoginPage): Promise<CommonRes>;
    signInWithCustomTicket(getTickFn?: authModels.GetCustomSignTicketFn): Promise<SignInRes>;
    signInWithOpenId({ useWxCloud }?: {
        useWxCloud?: boolean;
    }): Promise<SignInRes>;
    signInWithPhoneAuth({ phoneCode, useWxCloud }: {
        phoneCode?: string;
        useWxCloud?: boolean;
    }): Promise<SignInRes>;
    bindPhoneNumber(params: authModels.BindPhoneRequest): Promise<void>;
    unbindProvider(params: authModels.UnbindProviderRequest): Promise<void>;
    bindEmail(params: authModels.BindEmailRequest): Promise<void>;
    verify(params: authModels.VerifyRequest): Promise<authModels.VerifyResponse>;
    getVerification(params: authModels.GetVerificationRequest, options?: {
        withCaptcha: boolean;
    }): Promise<authModels.GetVerificationResponse>;
    get currentUser(): User;
    getCurrentUser(isRefresh?: boolean): Promise<(authModels.UserInfo & Partial<User>) | null>;
    signInAnonymouslyInWx({ useWxCloud, }?: {
        useWxCloud?: boolean;
    }): Promise<LoginState>;
    bindOpenId(): Promise<void>;
    signInWithUnionId(): Promise<LoginState>;
    signInWithSms({ verificationInfo, verificationCode, phoneNum, bindInfo, }: {
        verificationInfo?: {
            verification_id: string;
            is_user: boolean;
        };
        verificationCode?: string;
        phoneNum?: string;
        bindInfo?: any;
    }): Promise<LoginState>;
    signInWithEmail({ verificationInfo, verificationCode, bindInfo, email, }: {
        verificationInfo?: {
            verification_id: string;
            is_user: boolean;
        };
        verificationCode?: string;
        bindInfo?: any;
        email?: string;
    }): Promise<LoginState>;
    setCustomSignFunc(getTickFn: authModels.GetCustomSignTicketFn): void;
    signIn(params: authModels.SignInRequest): Promise<LoginState>;
    setPassword(params: authModels.SetPasswordRequest): Promise<void>;
    isUsernameRegistered(username: string): Promise<boolean>;
    hasLoginState(): LoginState | null;
    getLoginState(): Promise<LoginState | null>;
    getUserInfo(): Promise<(authModels.UserInfo & Partial<User>) | null>;
    getWedaUserInfo(): Promise<any>;
    updateUserBasicInfo(params: authModels.ModifyUserBasicInfoRequest): Promise<void>;
    getAuthHeader(): {};
    bindWithProvider(params: authModels.BindWithProviderRequest): Promise<void>;
    queryUser(queryObj: authModels.QueryUserProfileRequest): Promise<authModels.QueryUserProfileResponse>;
    getAccessToken(): Promise<GetAccessTokenRes>;
    grantProviderToken(params: authModels.GrantProviderTokenRequest): Promise<authModels.GrantProviderTokenResponse>;
    patchProviderToken(params: authModels.PatchProviderTokenRequest): Promise<authModels.PatchProviderTokenResponse>;
    signInWithProvider(params: authModels.SignInWithProviderRequest): Promise<LoginState>;
    signInWithWechat(params?: any): Promise<LoginState>;
    grantToken(params: authModels.GrantTokenRequest): Promise<LoginState>;
    genProviderRedirectUri(params: authModels.GenProviderRedirectUriRequest): Promise<authModels.GenProviderRedirectUriResponse>;
    resetPassword(params: authModels.ResetPasswordRequest): Promise<void>;
    deviceAuthorize(params: authModels.DeviceAuthorizeRequest): Promise<authModels.DeviceAuthorizeResponse>;
    sudo(params: authModels.SudoRequest): Promise<authModels.SudoResponse>;
    deleteMe(params: authModels.WithSudoRequest): Promise<authModels.UserProfile>;
    getProviders(): Promise<authModels.ProvidersResponse>;
    loginScope(): Promise<string>;
    loginGroups(): Promise<string[]>;
    onLoginStateChanged(callback: Function): Promise<void>;
    refreshTokenForce(params: {
        version?: string;
    }): Promise<Credentials>;
    getCredentials(): Promise<Credentials>;
    setCredentials(credentials: Credentials): Promise<void>;
    getProviderSubType(): Promise<authModels.ProviderSubType>;
    createCaptchaData(params: {
        state: string;
        redirect_uri?: string;
    }): Promise<{
        token: string;
        data: string;
    }>;
    verifyCaptchaData(params: {
        token: string;
        key: string;
    }): Promise<{
        captcha_token: string;
        expires_in: number;
    }>;
    getMiniProgramQrCode(params: authModels.GetMiniProgramQrCodeRequest): Promise<authModels.GetMiniProgramQrCodeResponse>;
    getMiniProgramQrCodeStatus(params: authModels.GetMiniProgramQrCodeStatusRequest): Promise<authModels.GetMiniProgramQrCodeStatusResponse>;
    modifyPassword(params: authModels.ModifyUserBasicInfoRequest): Promise<void>;
    modifyPasswordWithoutLogin(params: authModels.ModifyPasswordWithoutLoginRequest): Promise<void>;
    getUserBehaviorLog(params: authModels.GetUserBehaviorLog): Promise<authModels.GetUserBehaviorLogRes>;
    signInWithUsername({ verificationInfo, verificationCode, username: rawUsername, bindInfo, loginType, }: {
        verificationInfo?: authModels.GetVerificationResponse;
        verificationCode?: string;
        username?: string;
        bindInfo?: any;
        loginType?: string;
    }): Promise<LoginState>;
    createLoginState(params?: {
        version?: string;
        query?: any;
    }, options?: {
        asyncRefreshUser?: boolean;
        userInfo?: any;
    }): Promise<LoginState>;
    setAccessKey(): Promise<void>;
    protected formatPhone(phone: string): string;
    private notifyListeners;
    private setupListeners;
    private convertToUser;
    private missingRequiredParam;
    private validateParams;
    private validateAtLeastOne;
    private init;
}
type TInitAuthOptions = Pick<ICloudbaseAuthConfig, 'region' | 'persistence' | 'i18n' | 'accessKey' | 'useWxCloud' | 'auth'> & Partial<AuthOptions> & {
    detectSessionInUrl?: boolean;
};
export declare function generateAuthInstance(config: TInitAuthOptions & {
    sdkVersion?: string;
}, options?: {
    clientId: ICloudbaseConfig['clientId'];
    env: ICloudbaseConfig['env'];
    apiOrigin?: string;
    getApiOrigin?: () => string;
    cache?: ICloudbaseCache;
    platform?: ICloudbase['platform'];
    app?: ICloudbase;
    debug?: ICloudbaseAuthConfig['debug'];
    detectSessionInUrl?: ICloudbaseAuthConfig['detectSessionInUrl'];
}): {
    authInstance: Auth;
    oauthInstance: CloudbaseOAuth;
};
export { UserInfo, Auth, WeixinAuthProvider, CustomAuthProvider, AnonymousAuthProvider };
export { AuthErrorCategory, AuthErrorCode, AuthError } from '@cloudbase/js-sdk/oauth';
export declare function registerAuth(app: Pick<ICloudbase, 'registerComponent'>): void;

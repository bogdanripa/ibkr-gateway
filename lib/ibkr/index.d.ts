// Type declarations for lib/ibkr/index.js — the JS module isn't part
// of the TS build (it's plain ESM consumed by both the CLI and the
// web gateway), so we declare the public surface here so src/*.ts
// can import { IbkrClient } from '../lib/ibkr/index.js' with types.

export interface IbkrClientState {
  cookies: Record<string, {
    value: string;
    path?: string;
    domain?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expires?: string;
    maxAge?: number;
  }>;
  kHex: string | null;
  userId: number | null;
  userName: string | null;
  paperUserName: string | null;
  isPendingApplicant: boolean | null;
  apiBase: string | null;
  portalPrefix: string | null;
  deviceId: string | null;
  tstToken: string | null;
  currentAccountId: string | null;
  accountsCache: Array<Record<string, unknown>> | null;
  accountsCacheAt: string | null;
  updatedAt: string | null;
}

export interface SignInOptions {
  username: string;
  password: string;
  mode?: "paper" | "live";
  headed?: boolean;
  totpSecret?: string | null;
  /**
   * 6-digit "Temporary Security Code" IBKR emails when our headless
   * Chromium looks like a new device. Required to complete sign-in
   * when that challenge fires; null/omitted on subsequent sign-ins
   * once the device is trusted.
   */
  emailCode?: string | null;
  onProgress?: (msg: string) => void;
  debugDir?: string;
}

export interface SignInResult {
  userId: number | null;
  userName: string | null;
  isPendingApplicant: boolean | null;
  paperUserName: string | null;
  apiBase: string | null;
  portalPrefix: string | null;
  brokerage: {
    state: "ok" | "unavailable";
    authenticated?: boolean;
    connected?: boolean;
    competing?: boolean;
    error?: string;
  };
  accounts: Array<Record<string, unknown>>;
  currentAccountId: string | null;
}

export interface PortfolioSnapshot {
  accountId: string;
  stocks: Array<Record<string, unknown>>;
  options: Array<Record<string, unknown>>;
  other: Record<string, Array<Record<string, unknown>>>;
  cash: Array<{
    ccy: string;
    cash?: number;
    netLiq?: number;
    unrealizedPnl?: number;
    realizedPnl?: number;
    excessLiq?: number;
    settledCash?: number;
  }>;
  errors: Record<string, string>;
}

export interface PlaceOrderArgs {
  accountId?: string;
  conid?: number;
  symbol?: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: string;
  limitPrice?: number;
  stopPrice?: number;
  tif?: "DAY" | "GTC" | "IOC" | "OPG";
  outsideRth?: boolean;
  onConfirm?: (msg: { id: string; message: string; messageIds: string[] }) => Promise<boolean> | boolean;
  onProgress?: (msg: string) => void;
}

export class IbkrClient {
  constructor(opts?: { state?: IbkrClientState | null; debug?: boolean });

  getState(): IbkrClientState;
  setState(state: IbkrClientState): void;
  isSignedIn(): boolean;

  signIn(opts: SignInOptions): Promise<SignInResult>;
  signOut(): Promise<void>;
  tickle(): Promise<Record<string, unknown>>;
  ensureBrokerage(opts?: { force?: boolean }): Promise<Record<string, unknown>>;

  getAccounts(opts?: { cache?: boolean }): Promise<Array<Record<string, unknown>>>;
  getDefaultAccountId(): Promise<string>;
  getCurrentAccount(): string | null;
  setCurrentAccount(accountId: string, opts?: { skipValidation?: boolean }): Promise<string>;
  unsetCurrentAccount(): void;

  getPositions(accountId?: string): Promise<PortfolioSnapshot>;
  getCash(accountId?: string): Promise<PortfolioSnapshot["cash"]>;

  searchSecurity(query: string, opts?: { name?: boolean }): Promise<Array<{
    conid: number;
    symbol: string | null;
    description: string | null;
    currency?: string | null;
    issuer?: string | null;
    sections: Array<Record<string, unknown>>;
  }>>;
  resolveConid(symbol: string): Promise<{ conid: number; description: string }>;
  getSecurityInfo(conid: number): Promise<{
    conid: number;
    symbol?: string;
    name?: string;
    currency?: string;
    listingExchange?: string;
    exchange?: string;
    secType?: string;
    raw: Record<string, unknown>;
  }>;
  getQuote(conid: number, opts?: { fields?: number[]; retries?: number }): Promise<Record<string, unknown>>;
  getHistory(conid: number, opts?: { period?: string; bar?: string; outsideRth?: boolean }): Promise<{
    startTime?: string;
    period: string;
    bar: string;
    points: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
  }>;
  getChange(conid: number, opts?: { period?: string; bar?: string }): Promise<null | { period: string; first: number; last: number; abs: number; pct: number }>;

  placeOrder(args: PlaceOrderArgs): Promise<Array<Record<string, unknown>>>;
  getOrders(opts?: { status?: string | string[]; accountId?: string }): Promise<Array<Record<string, unknown>>>;
  getOrderStatus(orderId: string | number): Promise<Record<string, unknown>>;
  cancelOrder(args: { orderId: string | number; accountId?: string }): Promise<Record<string, unknown>>;
  getTrades(): Promise<Array<Record<string, unknown>>>;
}

export class IbkrError extends Error {
  stage?: string;
  status?: number;
  body?: unknown;
  constructor(message: string, opts?: { stage?: string; status?: number; body?: unknown });
}

/**
 * Thrown from IbkrClient.signIn when IBKR shows the "Temporary Security
 * Code" challenge for a new device and no emailCode was supplied. The
 * caller should prompt the user, then re-call signIn with emailCode.
 */
export class EmailVerificationRequiredError extends Error {
  code: "EMAIL_VERIFICATION_REQUIRED";
  constructor();
}

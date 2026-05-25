// Domain-level errors with actionable messages.
//
// These errors are designed to be safe to surface to the API client —
// they MUST NOT contain credential values or other sensitive data.

export class IbkrError extends Error {
  public logs?: string;

  constructor(
    public readonly code: string,
    message: string,
    public readonly remediation?: string
  ) {
    super(message);
    this.name = "IbkrError";
  }

  /** JSON shape returned by the API on this error. */
  toResponse(): { error: string; code: string; remediation?: string; logs?: string } {
    return {
      error: this.message,
      code: this.code,
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.logs ? { logs: this.logs } : {}),
    };
  }
}

// ---- Specific errors --------------------------------------------------------

/**
 * Thrown when the headless Gateway login times out waiting for
 * authentication. The most common cause is that the IBKR username has 2FA
 * enabled — there is no human at login time to approve the push (§9.1).
 *
 * The remediation walks the user through creating a 2FA-free secondary
 * username, which is IBKR's supported pattern for API access.
 */
export const TWO_FACTOR_REMEDIATION = `
Your IBKR username appears to require 2FA, which this system cannot
satisfy headlessly. You need a 2FA-free SECONDARY username dedicated
to API access. Your primary username keeps its 2FA for the mobile app.

Steps to create one (~5 min in IBKR Client Portal, plus IBKR's
provisioning wait):

  1. Sign in to https://www.interactivebrokers.com with your PRIMARY
     username (the 2FA-enabled one).
  2. Top-right user menu → Settings → User Settings.
  3. Under "Users & Access Rights", click "Add User" (or similar —
     IBKR renames this control occasionally).
  4. Create a new SECONDARY username. Pick a name unrelated to your
     primary one. Set a strong password.
  5. Grant it the access this system needs:
        - Trading permissions for the markets/instruments you intend
          to trade through the API.
        - Read access to portfolio and account info.
  6. CRITICAL: do NOT enable IBKR Mobile 2FA on the secondary username.
     (IBKR may still prompt to enroll — decline. The "Secure Login
     System" setting must remain off for this user.)
  7. Wait for IBKR to provision the secondary user. Usually a few
     minutes; can take up to ~24 hours. You'll get an email when
     it's active.
  8. Sign in ONCE at https://www.interactivebrokers.com with the new
     secondary username to:
        - confirm the password works,
        - accept any first-login prompts,
        - dismiss any 2FA enrolment offers.
  9. Hand the secondary username + password to this system (it will
     store them in GCP Secret Manager and use them at spawn time).

If you've done all of the above and still see this error, retry the
connect — IBKR provisioning is sometimes laggy.
`.trim();

export class TwoFactorRequiredError extends IbkrError {
  constructor() {
    super(
      "TWO_FACTOR_REQUIRED",
      "IBKR login timed out — username likely has 2FA enabled, which is not supported.",
      TWO_FACTOR_REMEDIATION
    );
  }
}

/**
 * Thrown when IBKR rejects the credential outright. Stops further retry
 * attempts to avoid locking the IBKR account (§6.1, §7.1).
 */
export const CREDENTIAL_REJECTED_REMEDIATION = `
IBKR rejected the stored credential. This usually means the password
has changed, or the username is suspended.

Steps:
  1. Sign in at https://www.interactivebrokers.com with the SAME
     username this system uses, and verify the password works.
     - If you get a password-reset prompt, complete it now.
     - If the account is locked, follow IBKR's unlock flow.
  2. Once you can sign in manually, update the password stored by
     this system (via the console UI when available, or by re-running
     the onboarding flow).
  3. Retry connect.

We will NOT retry the rejected credential automatically — repeated
bad logins risk locking the IBKR account.
`.trim();

export class CredentialRejectedError extends IbkrError {
  constructor() {
    super(
      "CREDENTIAL_REJECTED",
      "IBKR rejected the stored credential.",
      CREDENTIAL_REJECTED_REMEDIATION
    );
  }
}

/**
 * Generic spawn timeout — the container started but the session never
 * reached authenticated == true within the deadline, AND we couldn't
 * find a stronger signal in the IBeam logs to pin it on 2FA or a
 * rejected password. Surfaces the log tail so the operator can see
 * what's going on.
 */
export const SPAWN_TIMEOUT_REMEDIATION = `
The IBeam container started but never reported an authenticated
session within the timeout. Common causes:

  - IBeam first-launch is slow on a small VM (cold Chromium boot).
    Retry once; subsequent launches are faster.
  - Outbound HTTPS from the VM to IBKR is blocked or rate-limited.
  - IBeam version drift — check that voyz/ibeam:latest is current.
  - For paper accounts: confirm the username starts with the paper
    prefix IBKR assigned you, and that you've signed in to
    https://www.interactivebrokers.com manually at least once to
    clear any first-login prompts.

The "logs" field below contains the last lines from the IBeam
container — look for a clear error message there.
`.trim();

export class SpawnTimeoutError extends IbkrError {
  constructor() {
    super(
      "SPAWN_TIMEOUT",
      "Gateway spawn timed out without authenticating.",
      SPAWN_TIMEOUT_REMEDIATION
    );
  }
}

// Drives a headless Chromium through https://www.interactivebrokers.com/sso/Login
// and extracts the cookies that the post-login pipeline needs.

import { freshTotp } from './totp.js';
//
// Why a real browser: see docs/cpg-protocol.md §3.1. The form is JS-
// rendered and the field/CSRF names drift; every working headless
// integration (IBeam, ib-insync sidecars) converged on a real browser.
//
// The selectors below mirror what the long-running IBeam project uses
// (which is the de-facto reference). Override them via env vars if
// IBKR rolls a new form:
//   IBKR_LOGIN_USER_SEL       (default: input[name="user_name"])
//   IBKR_LOGIN_PASS_SEL       (default: input[name="password"])
//   IBKR_LOGIN_SUBMIT_SEL     (default: input[type="submit"], button[type="submit"])
//   IBKR_LOGIN_URL            (default: https://www.interactivebrokers.com/sso/Login?forwardTo=22&RL=1&ip2loc=US)
//   IBKR_LOGIN_SUCCESS_COOKIE (default: XYZAB_AM.LOGIN)
//   IBKR_LOGIN_TIMEOUT_MS     (default: 60000)

// Selectors as of 2026 — extracted from /sso/lib/xyz.bundle.min.js (the
// IBKR "xyz" login SPA). The form may be one step (username +
// password visible together) or two-step (username first, then
// password). The driver handles both.
const DEFAULTS = {
  url: 'https://www.interactivebrokers.com/sso/Login?forwardTo=22&RL=1&ip2loc=US',
  userSel: '#xyz-field-username, input[name="username"]',
  passSel: '#xyz-field-password, input[name="password"]',
  // The two-step continue button (only present if password isn't shown yet):
  userSubmitSel: '.xyzblock-username-submit button, .xyzblock-username-submit input[type="submit"]',
  // The final form submit. NB: the form element itself has class
  // .xyzform-submit, so we must target a button inside it — not the
  // form. Listed buttons first; if none match we fall back to pressing
  // Enter in the password field.
  submitSel:
    '.xyz-button-login, form.xyzform-submit button[type="submit"], form.xyzform-submit input[type="submit"], button.xyz-button-login',
  // Live/Paper toggle. The form defaults to Live; paper-trading usernames
  // (e.g. "*paper") will hit weird 2FA-looking error states if you submit
  // without flipping this.
  paperToggleSel: 'input[name="paperSwitch"], #toggle1',
  paperLabelSel: 'label[for="toggle1"]',
  // Cookie consent banner — appears in a fresh browser context, blocks
  // clicks on the form. We dismiss it before doing anything.
  cookieDismissSel:
    '#btn_accept_cookies-banner, #btn_accept_cookies, #gdpr-reject-all-banner, #gdpr-reject-all',
  successCookie: 'XYZAB_AM.LOGIN',
  timeoutMs: 60_000,
};

function envOpts() {
  return {
    url: process.env.IBKR_LOGIN_URL || DEFAULTS.url,
    userSel: process.env.IBKR_LOGIN_USER_SEL || DEFAULTS.userSel,
    passSel: process.env.IBKR_LOGIN_PASS_SEL || DEFAULTS.passSel,
    userSubmitSel: process.env.IBKR_LOGIN_USER_SUBMIT_SEL || DEFAULTS.userSubmitSel,
    submitSel: process.env.IBKR_LOGIN_SUBMIT_SEL || DEFAULTS.submitSel,
    paperToggleSel: process.env.IBKR_LOGIN_PAPER_TOGGLE_SEL || DEFAULTS.paperToggleSel,
    paperLabelSel: process.env.IBKR_LOGIN_PAPER_LABEL_SEL || DEFAULTS.paperLabelSel,
    cookieDismissSel: process.env.IBKR_LOGIN_COOKIE_DISMISS_SEL || DEFAULTS.cookieDismissSel,
    successCookie: process.env.IBKR_LOGIN_SUCCESS_COOKIE || DEFAULTS.successCookie,
    timeoutMs: Number(process.env.IBKR_LOGIN_TIMEOUT_MS) || DEFAULTS.timeoutMs,
  };
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (e) {
    throw new Error(
      'playwright is not installed.\n' +
      '  fix: npm install playwright && npx playwright install chromium',
    );
  }
}

// Pulls every cookie from the browser context, normalising into the
// shape session.cookies uses. We deliberately keep cookies from all
// domains (ibkr.com, interactivebrokers.com, gdcdyn) — the api.js layer
// doesn't filter by domain, and the IBKR backend accepts the same
// XYZAB across both hostnames.
function normaliseCookies(cookies) {
  const out = {};
  for (const c of cookies) {
    if (!c.value) continue;
    out[c.name] = {
      value: c.value,
      path: c.path || '/',
      domain: c.domain,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
  }
  return out;
}

export async function loginWithBrowser({
  username,
  password,
  paper = false,
  headed = false,
  totpSecret = null,
  emailCode = null,
  /** Cookies from a previous sign-in (the session.cookies blob).
   *  Pre-loaded into the browser context so IBKR sees us as the same
   *  returning client and is less likely to trigger the new-device
   *  verification challenge. Optional. */
  priorCookies = null,
  onProgress = () => {},
  debugDir = process.env.IBKR_LOGIN_DEBUG_DIR,
} = {}) {
  if (!username || !password) throw new Error('username and password required');
  const opts = envOpts();
  const { chromium } = await loadPlaywright();

  onProgress(`launching chromium (${headed ? 'headed' : 'headless'})…`);
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Pre-load the previous session's cookies so IBKR sees this as the
  // same returning device. The translation here is the trickiest part:
  // Playwright's addCookies() needs either `url` or both `domain` AND
  // `path` for every entry. Our persisted shape may have a domain set
  // (from the Set-Cookie headers we originally captured) but in some
  // edge cases — cookies we mirrored into the jar without a domain —
  // it isn't. For those we infer a domain from the persisted IBKR
  // host. Bad cookies are silently dropped (Playwright rejects the
  // whole batch on one bad entry, hence the try-per-cookie loop).
  if (priorCookies && typeof priorCookies === 'object') {
    const candidates = [];
    for (const [name, c] of Object.entries(priorCookies)) {
      if (!c || !c.value) continue;
      // Reject cookies with no usable domain — without one Playwright
      // refuses to add them.
      const domain = c.domain || guessDomainFromHost();
      if (!domain) continue;
      candidates.push({
        name,
        value: String(c.value),
        domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
      });
    }
    if (candidates.length) {
      // addCookies tolerates partial failures only if we feed them
      // one-by-one — otherwise a single bad entry rejects the whole
      // batch. So loop, ignore failures.
      let added = 0;
      for (const cookie of candidates) {
        try { await context.addCookies([cookie]); added++; }
        catch { /* skip the malformed entry */ }
      }
      onProgress(`pre-loaded ${added}/${candidates.length} cookies from prior session`);
    }
  }
  // The IBKR login page injects a GDPR cookie consent modal
  // (#cookie-modal) and a related bottom banner (#cookie-header-banner)
  // at various points after page load — and it re-mounts them after
  // navigations / iframe loads. Click-to-dismiss is unreliable because
  // the modal can re-appear *after* we've moved past it and end up
  // intercepting a later submit click (which is exactly what happened
  // to the user's first live attempt — username got filled, but the
  // submit click hit the modal backdrop).
  //
  // The robust fix is to install a per-context init script that:
  //   1. Adds a CSS rule hiding the modal + backdrop + banner.
  //   2. Watches the DOM via MutationObserver and removes those nodes
  //      whenever the page re-creates them.
  // This is preventative — we still also call .click() on the dismiss
  // button when one is visible (so IBKR records consent if it cares),
  // but the modal can no longer block our clicks even if our click
  // attempt races and misses.
  await context.addInitScript(() => {
    const apply = () => {
      const css = document.createElement('style');
      css.setAttribute('data-injected-by', 'ibkr-cli-cookie-suppressor');
      css.textContent = `
        #cookie-modal, .modal-backdrop, #cookie-header-banner { display: none !important; }
        body.modal-open { overflow: auto !important; padding-right: 0 !important; }
      `;
      (document.head || document.documentElement).appendChild(css);
      const purge = () => {
        document
          .querySelectorAll('#cookie-modal, .modal-backdrop, #cookie-header-banner')
          .forEach((el) => el.remove());
        document.body && document.body.classList.remove('modal-open');
      };
      purge();
      new MutationObserver(purge).observe(
        document.documentElement,
        { childList: true, subtree: true },
      );
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
      apply();
    }
  });

  const page = await context.newPage();

  try {
    onProgress(`opening ${opts.url}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });

    // Polite consent click — try each visible dismiss button; the
    // init-script above already kills the modal so this is just so
    // IBKR's analytics see a consent event.
    const dismissCookieBanner = async (label = 'dismissing cookie consent banner') => {
      const btns = page.locator(opts.cookieDismissSel);
      const n = await btns.count();
      for (let i = 0; i < n; i++) {
        const b = btns.nth(i);
        if (await b.isVisible({ timeout: 50 }).catch(() => false)) {
          onProgress(label);
          await b.click({ timeout: 2000, force: true }).catch(() => {});
          return;
        }
      }
    };
    await dismissCookieBanner();

    onProgress(`waiting for login form (${opts.userSel})`);
    // The form is rendered by xyz.bundle.min.js into .loginformWrapper —
    // there are no inputs in the initial HTML. We rely on Playwright's
    // built-in JS execution + waitForSelector to bridge that.
    await page.waitForSelector(opts.userSel, { timeout: opts.timeoutMs, state: 'visible' });

    if (paper) {
      onProgress('flipping Live → Paper toggle');
      // The toggle is <input type=checkbox name=paperSwitch id=toggle1>
      // hidden behind a <label for=toggle1>. The label is what's actually
      // clickable, but we use the JS `check` API for reliability.
      const cb = page.locator(opts.paperToggleSel).first();
      const exists = (await cb.count()) > 0;
      if (!exists) {
        onProgress('warning: paperSwitch input not found — submitting without flipping');
      } else {
        const already = await cb.isChecked().catch(() => false);
        if (!already) {
          try {
            // .check() requires the element to be visible. The checkbox is
            // hidden behind the label; pass force:true.
            await cb.check({ force: true });
          } catch {
            // Fall back to clicking the label.
            await page.locator(opts.paperLabelSel).first().click({ force: true }).catch(() => {});
          }
        }
        // Confirm via the page's own body.paper-trading class or the
        // "Simulated" banner that the toggle's JS sets.
        const ok = await page
          .locator('body.paper-trading, text=/simulated/i')
          .first()
          .isVisible({ timeout: 1500 })
          .catch(() => false);
        onProgress(ok ? 'paper mode confirmed' : 'paper toggle set (no Simulated banner detected — proceeding)');
      }
    }

    onProgress('filling username');
    await page.fill(opts.userSel, username);

    // Detect the two-step form: if the password field isn't visible yet,
    // click the "Continue" / username-submit button first.
    const passVisible = await page
      .locator(opts.passSel)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!passVisible) {
      const userSubmit = page.locator(opts.userSubmitSel).first();
      if (await userSubmit.isVisible({ timeout: 500 }).catch(() => false)) {
        onProgress('two-step form: clicking Continue');
        await userSubmit.click();
      }
      onProgress('waiting for password field');
      await page.waitForSelector(opts.passSel, { timeout: opts.timeoutMs, state: 'visible' });
    }

    onProgress('filling password');
    await page.fill(opts.passSel, password);

    // Banner sometimes re-mounts after toggle/input interactions; clear
    // it again just before the click so it can't eat our submit.
    await dismissCookieBanner('re-dismissing cookie banner');

    onProgress('submitting');
    let submitted = false;
    const submitBtn = page.locator(opts.submitSel).first();
    if (await submitBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      try {
        await submitBtn.click({ timeout: 5000 });
        submitted = true;
      } catch { /* fall through to Enter */ }
    }
    if (!submitted) {
      onProgress('no visible submit button — pressing Enter in password field');
      await page.locator(opts.passSel).first().press('Enter');
    }

    // 2FA / Authenticator-App stage. IBKR may now show:
    //   · a device picker (when multiple 2FA methods are enrolled), then
    //   · a 6-digit code input, OR
    //   · directly the 6-digit code input (single 2FA method).
    // If we have a totpSecret, fill it; otherwise the user must complete
    // 2FA manually in a --headed browser (existing behaviour).
    if (totpSecret) {
      await handleTotp(page, totpSecret, onProgress, opts.timeoutMs);
    }

    // New-device / email-verification stage. IBKR uses TWO different
    // surfaces for this challenge — we have to handle both:
    //   1. xyzblock-temp inside /sso/Login — the in-form
    //      "Temporary Security Code" field. Older flow.
    //   2. A standalone /restricted/ page titled "Verification Needed"
    //      with form.form-email + input[name="email-code"]. This is
    //      what fires once IBKR has flagged the account as
    //      "restricted" (typically after repeated unrecognised-device
    //      sign-ins). The browser appears to "succeed" past sso/Login,
    //      lands on /restricted/, and stays there until the user
    //      verifies — which is why our previous detection missed it.
    await handleEmailVerification(page, emailCode, onProgress);
    await handleRestrictedVerification(page, emailCode, onProgress);

    // Two terminal states we care about:
    //   (a) success → the success cookie appears in the context, OR
    //                  the URL contains /sso/Dispatcher
    //   (b) failure → an error banner appears, or the form is still there
    //                  past the timeout.
    onProgress(`waiting for success cookie (${opts.successCookie}) or /sso/Dispatcher…`);
    const deadline = Date.now() + opts.timeoutMs;
    let success = false;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      if (cookies.some((c) => c.name === opts.successCookie && c.value)) {
        success = true; break;
      }
      const url = page.url();
      if (url.includes('/sso/Dispatcher') || url.includes('/portal.proxy')) {
        success = true; break;
      }
      // Failure detection — IBKR renders the entire xyz form into one
      // DOM with display:none toggles, so a text match is meaningless
      // unless the element is actually visible. Check the two surfaces
      // IBKR uses for real errors:
      //   1. <div role="alert"> — top-of-form banner, e.g.
      //      "You have selected the Live Account Mode, but the
      //      specified user is a Paper Trading user..."
      //   2. .invalid-feedback under an .is-invalid input — Bootstrap
      //      field validation (e.g. "Invalid username password
      //      combination", "Incorrect security code").
      const surfaces = ['[role="alert"]', '.is-invalid + .invalid-feedback, .is-invalid ~ .invalid-feedback'];
      for (const sel of surfaces) {
        for (const m of await page.locator(sel).all().catch(() => [])) {
          if (!(await m.isVisible({ timeout: 100 }).catch(() => false))) continue;
          const txt = (await m.textContent({ timeout: 100 }).catch(() => null))?.trim();
          if (!txt) continue;
          // Specific actionable hint for the most common foot-gun.
          if (/Live Account Mode.*Paper Trading user/i.test(txt)) {
            throw new Error(
              `IBKR login refused: ${txt.slice(0, 250)}\n` +
              `  hint: re-run with --paper (or IBKR_PAPER=1)`,
            );
          }
          throw new Error(`IBKR login refused: ${txt.slice(0, 250)}`);
        }
      }
      await page.waitForTimeout(500);
    }
    if (!success) {
      throw new Error(
        `login did not produce ${opts.successCookie} cookie within ${opts.timeoutMs}ms ` +
        `(current url: ${page.url()})`,
      );
    }

    // The XYZAB cookies appear as soon as IBKR returns the first 302
    // off /sso/Login, but the USERID cookie (which sso/validate
    // requires — "No userid cookie" 401 if it isn't there) is set
    // further down the redirect chain when the browser lands on the
    // portal/AccountManagement page. The chain is noticeably slower on
    // live than on paper, so a fixed dwell is unreliable — we poll for
    // USERID specifically. Anything up to 20 s is normal for live;
    // paper usually settles in 1-2 s.
    onProgress('waiting for post-login redirect to settle');
    await page.waitForURL((url) => !url.toString().includes('/sso/Login'), {
      timeout: 20_000,
    }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    onProgress('waiting for USERID cookie');
    const userIdDeadline = Date.now() + 20_000;
    let gotUserId = false;
    while (Date.now() < userIdDeadline) {
      const cookies = await context.cookies();
      if (cookies.some((c) => c.name === 'USERID' && c.value)) { gotUserId = true; break; }
      await page.waitForTimeout(500);
    }
    if (!gotUserId) {
      onProgress('warning: USERID cookie did not appear within 20s — sso/validate may fail');
    }
    // Small trailing dwell so any final Set-Cookie that landed just
    // before USERID also gets captured.
    await page.waitForTimeout(750);

    // Pick the API host + portal prefix from where we ended up.
    //   *.ibkr.com           → /v1/api
    //   *.interactivebrokers.* → /portal.proxy/v1/portal
    const finalUrl = new URL(page.url());
    let apiBase, portalPrefix;
    if (/(^|\.)ibkr\.com$/i.test(finalUrl.hostname)) {
      apiBase = `${finalUrl.protocol}//${finalUrl.hostname}`;
      portalPrefix = '/v1/api';
    } else {
      apiBase = `${finalUrl.protocol}//${finalUrl.hostname}`;
      portalPrefix = '/portal.proxy/v1/portal';
    }
    onProgress(`picked apiBase=${apiBase}  portalPrefix=${portalPrefix}`);

    onProgress('login succeeded — extracting cookies');
    const all = await context.cookies();
    if (debugDir) await dumpDebug(page, debugDir, 'success', onProgress);
    return { cookies: normaliseCookies(all), apiBase, portalPrefix, finalUrl: page.url() };
  } catch (err) {
    if (debugDir) await dumpDebug(page, debugDir, 'failure', onProgress);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Fallback domain for cookies persisted without one. The actual IBKR
// site IBKR cookies live on is *.interactivebrokers.com (both live
// and paper); we pick that as the safest default. If the cookie was
// actually for *.ibkr.com it'll be a no-op (the page on
// interactivebrokers.com won't see it) — but we never lose anything.
function guessDomainFromHost() {
  return '.interactivebrokers.com';
}

async function dumpDebug(page, debugDir, kind, onProgress) {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(debugDir, { recursive: true });
    await page.screenshot({ path: `${debugDir}/page.png`, fullPage: true });
    await writeFile(`${debugDir}/page.html`, await page.content());
    await writeFile(`${debugDir}/url.txt`, page.url());
    await writeFile(`${debugDir}/kind.txt`, kind);
    onProgress(`debug dump (${kind}) written to ${debugDir}/{page.png,page.html,url.txt}`);
  } catch (e) {
    onProgress(`debug dump (${kind}) failed: ${e.message}`);
  }
}

// ----------------- TOTP / Authenticator-App handling ----------------

// Selectors for the visible-input slots IBKR shows on the second-factor
// screen. We try them in order — IBKR Authenticator App responses go
// into one of these (most commonly `silver`, the generic 6-digit
// "Security Code" field; for users that have ONLY the Auth App
// enrolled, the field might be unmarked and we fall back to any
// visible 6-digit numeric input on the page).
const TOTP_FIELD_CANDIDATES = [
  '#xyz-field-silver-response',
  '#xyz-field-bronze-response',
  '#xyz-field-gold-response',
  '#xyz-field-temp-response',
  // Generic fallbacks — any visible 6-digit numeric input.
  'input[inputmode="numeric"]',
  'input[autocomplete="one-time-code"]',
];

// The second-factor picker (.xyzblock-multiplesf) is a real <select>
// when IBKR has multiple methods enrolled. We saw this empirically:
//   <select class="form-control xyz-multipleselect">
//     <option value="">Select Type</option>
//     <option value="5.2a">IB Key</option>
//     <option value="4">Mobile Authenticator App</option>
//   </select>
// Clicking an <option> does nothing in Playwright — we have to call
// selectOption() on the <select>. After selection IBKR's JS unhides
// the corresponding xyzblock-* form (xyzblock-silver for TOTP, which
// contains #xyz-field-silver-response).
const PICKER_SELECT_SELECTOR =
  'select.xyz-multipleselect, .xyzblock-multiplesf select, select[name*="second"]';

// Texts we'll try to match against the picker's <option> labels.
const AUTHAPP_OPTION_RE = /(mobile\s+)?authenticator\s+app|soft\s+token|totp/i;

async function findFirstVisible(page, selectors, timeout = 200) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout }).catch(() => false)) return loc;
  }
  return null;
}

async function selectAuthAppFromPicker(page, picker, onProgress) {
  // Read the option labels so we can match by label text without
  // hardcoding IBKR's internal value codes (which we know to be "4"
  // today but could change). Fall back to value="4" if no label match.
  const options = await picker
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => ({ value: o.value, label: (o.textContent || '').trim() })))
    .catch(() => []);
  const match = options.find((o) => AUTHAPP_OPTION_RE.test(o.label));
  if (match) {
    onProgress(`picker: selecting "${match.label}" (value=${match.value})`);
    await picker.selectOption({ value: match.value }).catch(() => picker.selectOption({ label: match.label }));
    return true;
  }
  // Last-resort fallback to the value we observed in May 2026.
  onProgress('picker: no label matched, trying value="4"');
  return picker
    .selectOption({ value: '4' })
    .then(() => true)
    .catch(() => false);
}

async function handleTotp(page, totpSecret, onProgress, timeoutMs) {
  // Give IBKR a beat to render the post-credentials screen.
  // We'll poll for either a 2FA input or a picker for up to 15s.
  onProgress('waiting for 2FA screen');
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);

  let picker = null;
  let field = null;
  while (Date.now() < deadline) {
    const sel = page.locator(PICKER_SELECT_SELECTOR).first();
    if (await sel.isVisible({ timeout: 100 }).catch(() => false)) {
      picker = sel;
    }
    field = await findFirstVisible(page, TOTP_FIELD_CANDIDATES);
    if (picker || field) break;
    // If the success cookie / Dispatcher URL appears first, login
    // completed without asking for 2FA (e.g. trusted device) — bail.
    const url = page.url();
    if (url.includes('/sso/Dispatcher') || url.includes('/portal.proxy')) {
      onProgress('login completed without 2FA prompt — skipping TOTP');
      return;
    }
    await page.waitForTimeout(300);
  }

  if (picker) {
    onProgress('2FA device picker shown — selecting Authenticator App');
    await selectAuthAppFromPicker(page, picker, onProgress);
    // Wait for the code field to appear after the select.
    const fieldDeadline = Date.now() + 10_000;
    while (Date.now() < fieldDeadline) {
      field = await findFirstVisible(page, TOTP_FIELD_CANDIDATES);
      if (field) break;
      await page.waitForTimeout(300);
    }
  }

  if (!field) {
    onProgress('no 2FA input field appeared — proceeding without TOTP fill');
    return;
  }

  // Generate a fresh code (waits up to one step if current window is
  // about to expire — avoids the "Incorrect security code" race).
  onProgress('generating TOTP code');
  let { code } = await freshTotp(totpSecret);
  onProgress('filling TOTP code');
  await field.fill(code);
  await field.press('Enter').catch(() => {});

  // If IBKR rejects the first try (clock skew or rotation race), wait
  // for the next 30-second window and retry exactly once.
  const retryDeadline = Date.now() + 8_000;
  while (Date.now() < retryDeadline) {
    const rejected = await page
      .locator('text=/incorrect security code|invalid (security )?code/i')
      .first()
      .isVisible({ timeout: 100 })
      .catch(() => false);
    if (rejected) {
      onProgress('TOTP rejected — waiting for next window and retrying once');
      ({ code } = await freshTotp(totpSecret, { minRemainingMs: 10_000 }));
      const stillThere = await findFirstVisible(page, TOTP_FIELD_CANDIDATES);
      if (stillThere) {
        await stillThere.fill(code);
        await stillThere.press('Enter').catch(() => {});
      }
      return;
    }
    // Quick win: success cookie / Dispatcher appearing.
    const url = page.url();
    if (url.includes('/sso/Dispatcher') || url.includes('/portal.proxy')) return;
    await page.waitForTimeout(300);
  }
}

// ----------------- New-device "Temporary Security Code" -------------

/**
 * Thrown when IBKR's new-device challenge fires and we don't yet have
 * the email code. Callers (gateway) catch this, surface a "paste your
 * IBKR verification code" UI, and retry signIn() with emailCode set.
 */
export class EmailVerificationRequiredError extends Error {
  constructor() {
    super(
      'IBKR sent a verification code to the account email. ' +
      'Retry the sign-in with emailCode set to the 6-digit code from the email.',
    );
    this.name = 'EmailVerificationRequiredError';
    this.code = 'EMAIL_VERIFICATION_REQUIRED';
  }
}

const EMAIL_CODE_FIELD_CANDIDATES = [
  '#xyz-field-temp-response',
  'input[name="temp-response"]',
];
// IBKR's "Login Security Code" header / description hints we use to
// distinguish the email-verification screen from the TOTP screen
// (both can use silver-response but with different surrounding text).
const EMAIL_VERIFICATION_HINTS = [
  'text=/temporary security code/i',
  'text=/login security code/i',
  '.xyzblock-temp:not([style*="display: none"])',
];

async function handleEmailVerification(page, emailCode, onProgress) {
  // Poll briefly for either the temp-response field OR the success
  // signals. If the field doesn't appear, login proceeded normally and
  // we're done.
  const deadline = Date.now() + 8_000;
  let field = null;
  while (Date.now() < deadline) {
    field = await findFirstVisible(page, EMAIL_CODE_FIELD_CANDIDATES, 100);
    if (field) break;
    // Bail early if login already succeeded — no challenge for us to handle.
    const url = page.url();
    if (url.includes('/sso/Dispatcher') || url.includes('/portal.proxy')) return;
    // The success cookie is a per-domain thing; we don't have the
    // context here, so we just check for the URL transition.
    await page.waitForTimeout(300);
  }
  if (!field) return; // No challenge fired — normal flow.

  // Sanity check: is the visible context actually about email
  // verification (vs. some other use of #xyz-field-temp-response)?
  let isEmailChallenge = false;
  for (const hint of EMAIL_VERIFICATION_HINTS) {
    if (await page.locator(hint).first().isVisible({ timeout: 100 }).catch(() => false)) {
      isEmailChallenge = true; break;
    }
  }
  if (!isEmailChallenge) {
    onProgress('temp-code field visible but no email-verification copy detected — proceeding without filling');
    return;
  }

  if (!emailCode) {
    onProgress('IBKR is asking for an emailed verification code — none supplied; throwing EmailVerificationRequiredError');
    throw new EmailVerificationRequiredError();
  }

  onProgress('filling emailed verification code');
  await field.fill(String(emailCode).trim());
  await field.press('Enter').catch(() => {});

  // Wait briefly for either success transition or an "incorrect code"
  // error. We don't loop-and-retry here because the user typed the
  // code; if it's wrong they need to read the email again.
  const retryDeadline = Date.now() + 6_000;
  while (Date.now() < retryDeadline) {
    const url = page.url();
    if (url.includes('/sso/Dispatcher') || url.includes('/portal.proxy')) return;
    const rejected = await page
      .locator('text=/incorrect|invalid (security )?code/i')
      .first()
      .isVisible({ timeout: 100 })
      .catch(() => false);
    if (rejected) {
      throw new Error('IBKR rejected the emailed verification code — request a fresh one and retry.');
    }
    await page.waitForTimeout(300);
  }
}

/**
 * IBKR /restricted/ page — "Verification Needed".
 *
 * Triggered when IBKR has flagged the account as restricted (typically
 * after repeated unrecognised-device sign-ins). The browser navigates
 * here AFTER /sso/Login claims success. Different DOM from the xyz
 * form: form.form-email + input[name="email-code"] + button[type="submit"]
 * (the .btn-primary one — there's also a .btn-secondary "Skip
 * Verification" we must avoid).
 *
 * If we land here without an emailCode, throw so the caller can
 * surface the prompt. With one, fill + submit + wait for transition.
 */
async function handleRestrictedVerification(page, emailCode, onProgress) {
  // Poll briefly. If we never see /restricted/ this is a no-op.
  const deadline = Date.now() + 8_000;
  let onPage = false;
  while (Date.now() < deadline) {
    if (page.url().includes('/restricted/')) { onPage = true; break; }
    // Also detect by element in case URL hash routing is used.
    const found = await page
      .locator('form.form-email input[name="email-code"]')
      .first()
      .isVisible({ timeout: 100 })
      .catch(() => false);
    if (found) { onPage = true; break; }
    await page.waitForTimeout(300);
  }
  if (!onPage) return;

  onProgress('IBKR /restricted/ page shown — needs email verification token');
  if (!emailCode) throw new EmailVerificationRequiredError();

  const input = page.locator('form.form-email input[name="email-code"]').first();
  await input.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  await input.fill(String(emailCode).trim());

  // The Submit button inside form.form-email — be specific so we
  // don't click the .btn-secondary "Skip Verification" instead.
  const submit = page.locator('form.form-email button[type="submit"].btn-primary').first();
  await submit.click({ timeout: 5_000 });
  onProgress('verification token submitted');

  // Wait for either an error (rejected/expired) or the page to leave
  // /restricted/. After a successful verify the page may show a
  // "Continue login" button — click it when present.
  const retryDeadline = Date.now() + 20_000;
  while (Date.now() < retryDeadline) {
    const rejected = await page
      .locator('text=/Verification Failed|invalid|incorrect|expired/i')
      .first()
      .isVisible({ timeout: 100 })
      .catch(() => false);
    if (rejected) {
      throw new Error('IBKR rejected the verification token — it may have expired. Request a fresh one and retry.');
    }
    const continueBtn = page.locator('text=/Continue login/i').first();
    if (await continueBtn.isVisible({ timeout: 100 }).catch(() => false)) {
      onProgress('clicking "Continue login"');
      await continueBtn.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    if (!page.url().includes('/restricted/')) {
      onProgress('left /restricted/ — verification accepted');
      return;
    }
    await page.waitForTimeout(400);
  }
  // If we're still on /restricted/, something else is wrong (e.g. they
  // also require phone or AU10TIX). Surface a clear error.
  throw new Error(
    'Verified email but still on /restricted/ — IBKR may also require ' +
    'phone or identity verification (visit https://www.interactivebrokers.com manually).',
  );
}

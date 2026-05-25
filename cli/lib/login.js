// Drives a headless Chromium through https://www.interactivebrokers.com/sso/Login
// and extracts the cookies that the post-login pipeline needs.
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
  const page = await context.newPage();

  try {
    onProgress(`opening ${opts.url}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });

    // 1. Dismiss the GDPR cookie banner if it's covering the form.
    {
      const cookieBtn = page.locator(opts.cookieDismissSel).first();
      if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        onProgress('dismissing cookie consent banner');
        await cookieBtn.click({ timeout: 5000 }).catch(() => {});
        // Give it a beat to animate out so it doesn't intercept later clicks.
        await page.waitForTimeout(300);
      }
    }

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
      // Failure detection — IBKR renders the entire xyz form (every
      // possible error / 2FA screen) into one DOM with display:none
      // toggles, so a text match is meaningless unless the element is
      // actually visible. We iterate matches and check visibility.
      const matches = await page
        .locator(
          'text=/(invalid|incorrect|password|2-step|two[- ]factor|security challenge|locked|disabled)/i',
        )
        .all()
        .catch(() => []);
      for (const m of matches) {
        if (!(await m.isVisible({ timeout: 100 }).catch(() => false))) continue;
        const txt = (await m.textContent({ timeout: 100 }).catch(() => null))?.trim();
        if (!txt) continue;
        // Ignore neutral / informational mentions of these words.
        if (/^(password|two[- ]factor|two-step)$/i.test(txt)) continue;
        if (/problem with logging in\?/i.test(txt)) continue;
        throw new Error(`IBKR login refused: "${txt.slice(0, 200)}"`);
      }
      await page.waitForTimeout(500);
    }
    if (!success) {
      throw new Error(
        `login did not produce ${opts.successCookie} cookie within ${opts.timeoutMs}ms ` +
        `(current url: ${page.url()})`,
      );
    }

    // The success cookie appears as soon as IBKR returns the first 302
    // off /sso/Login, but the USERID cookie (which sso/validate requires)
    // is set further down the redirect chain when the browser lands on
    // the portal/AccountManagement page. Wait for the URL to leave the
    // login page, then a small dwell so trailing Set-Cookies land.
    onProgress('waiting for post-login redirect to settle');
    await page.waitForURL((url) => !url.toString().includes('/sso/Login'), {
      timeout: opts.timeoutMs,
    }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1500);

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
    return { cookies: normaliseCookies(all), apiBase, portalPrefix, finalUrl: page.url() };
  } catch (err) {
    if (debugDir) {
      try {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(debugDir, { recursive: true });
        await page.screenshot({ path: `${debugDir}/page.png`, fullPage: true });
        await writeFile(`${debugDir}/page.html`, await page.content());
        await writeFile(`${debugDir}/url.txt`, page.url());
        onProgress(`debug dump written to ${debugDir}/{page.png,page.html,url.txt}`);
      } catch (e) { onProgress(`debug dump failed: ${e.message}`); }
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

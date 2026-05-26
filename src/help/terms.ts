// /terms — public Terms of Use for the hosted instance of IBKR
// Gateway. No auth. Uses the same chrome as the other marketing
// pages via renderHelpPage.

import { renderHelpPage } from "./layout.js";

export function termsHtml(): string {
  return renderHelpPage({
    title: "Terms of Use",
    bodyHtml: `
<h1>Terms of Use</h1>

<p class="muted">Last updated: 2026-05-26</p>

<p>
  By accessing or using IBKR Gateway (the "Service") at
  <code>ibkr-gateway.bogdanripa.com</code>, you agree to these
  Terms of Use. If you do not agree, do not use the Service.
</p>

<h2>1. What the Service is</h2>
<ul>
  <li>
    A free, hosted bridge that exposes your Interactive Brokers
    account through the
    <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">Model Context Protocol</a>
    (MCP) so AI hosts like Claude, ChatGPT, and Cursor can read your
    positions and (with your consent) place orders.
  </li>
  <li>
    Provided "as is". Open-source under
    <a href="https://github.com/bogdanripa/ibkr-gateway" target="_blank" rel="noopener">github.com/bogdanripa/ibkr-gateway</a>;
    you may self-host instead of using the hosted instance.
  </li>
  <li>
    An <strong>independent project</strong>. Not affiliated with,
    endorsed by, or sponsored by Interactive Brokers. "Interactive
    Brokers" and "IBKR" are trademarks of their respective owners.
  </li>
</ul>

<h2>2. Your responsibilities</h2>
<ul>
  <li>
    You must hold a valid Interactive Brokers account and comply with
    IBKR's terms of service. The Service uses your real IBKR
    credentials to sign in on your behalf — that activity is
    attributable to <em>you</em>, not to us.
  </li>
  <li>
    You are solely responsible for every order placed through the
    Service, including orders initiated by AI hosts you have
    authorized with the read &amp; write scope.
  </li>
  <li>
    You control which apps can place orders. Read-only is the default
    at consent time; you may grant read &amp; write only when you
    intend an app to trade.
  </li>
  <li>
    You must not use the Service for unlawful trading, market
    manipulation, evasion of sanctions, or any activity that violates
    IBKR's terms or applicable law.
  </li>
</ul>

<h2>3. No financial advice</h2>
<p>
  The Service is a connectivity tool. It does not provide investment
  advice, recommendations, or solicitations to buy or sell securities.
  Output produced by connected AI hosts is not advice from us, and
  may be incorrect. You alone make trading decisions and bear the
  consequences.
</p>

<h2>4. No warranty</h2>
<p>
  The Service is provided <strong>"AS IS"</strong> and
  <strong>"AS AVAILABLE"</strong> without warranties of any kind,
  express or implied, including (without limitation) merchantability,
  fitness for a particular purpose, non-infringement, accuracy, or
  uninterrupted availability. The Service may be unavailable,
  delayed, or return stale or incorrect data. Do not rely on it for
  time-sensitive trading.
</p>

<h2>5. Limitation of liability</h2>
<p>
  To the maximum extent permitted by law, the operator of the Service
  is not liable for any loss, damage, or expense — whether direct,
  indirect, incidental, consequential, exemplary, or punitive —
  arising from your use of, or inability to use, the Service. This
  expressly includes trading losses, missed trades, slippage, data
  loss, and downtime.
</p>
<p>
  If liability cannot be excluded under applicable law, total
  aggregate liability is limited to the amount you have paid for the
  Service in the twelve months preceding the claim — which, since
  the Service is free, is zero.
</p>

<h2>6. Service availability and changes</h2>
<p>
  The hosted Service may be modified, rate-limited, restricted, or
  discontinued at any time, with or without notice. If continuity
  matters to you, self-host the open-source code on your own
  infrastructure.
</p>

<h2>7. Termination</h2>
<p>
  You can stop using the Service at any time by deleting your
  connections and revoking authorized apps from the console. We may
  suspend or terminate your access to the hosted Service at any time,
  with or without notice, including (but not limited to) if you
  violate these Terms or IBKR's terms.
</p>

<h2>8. Changes to these Terms</h2>
<p>
  We may update these Terms. The "Last updated" date above reflects
  the most recent revision. Continued use of the Service after
  changes are posted constitutes acceptance.
</p>

<h2>9. Contact</h2>
<p>
  Questions about these Terms? Reach us through the
  <a href="/contact">contact form</a>.
</p>

<p class="muted">
  See also the <a href="/privacy">Privacy Policy</a>.
</p>
`,
  });
}

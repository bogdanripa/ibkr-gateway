// /contact/thanks — confirmation page shown after a successful
// POST /contact/submit. Public, static, no auth.

import { renderHelpPage } from "./layout.js";

export function contactThanksHtml(): string {
  return renderHelpPage({
    title: "Message received",
    bodyHtml: `
<h1>Message received</h1>

<div class="ok">
  <strong>Thanks — your message is in our inbox.</strong>
  We'll reply to the email address you provided. Most messages get a
  response within a couple of business days.
</div>

<p>
  In the meantime:
</p>
<ul>
  <li>Browse the <a href="/help/mcp">MCP setup guide</a> if you're trying to wire up Claude / ChatGPT / Cursor.</li>
  <li>Take a look at <a href="/help/paper-account">paper accounts</a> if you haven't set one up yet.</li>
  <li>Manage your connections in the <a href="/console">console</a>.</li>
</ul>

<p class="muted">
  If you sent a deletion request, we'll confirm by email once the
  account, connections, OAuth records, and Secret Manager entries
  are gone.
</p>
`,
  });
}

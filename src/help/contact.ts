// /contact — public contact form. No auth. Submits to
// POST /contact/submit (handled in src/contact.ts) which writes to
// the ibkr_contact_messages Firestore collection and redirects to
// /contact/thanks.

import { renderHelpPage } from "./layout.js";

export function contactHtml(): string {
  return renderHelpPage({
    title: "Contact",
    bodyHtml: `
<h1>Contact</h1>

<p>
  Got a question, a deletion request, a security report, or feedback
  on IBKR Gateway? Send it here. Submissions land directly in our
  inbox; please include enough context that we can answer without a
  back-and-forth.
</p>

<form method="post" action="/contact/submit" class="contact-form" novalidate>
  <div class="field">
    <label for="name">Your name</label>
    <input id="name" name="name" type="text" required maxlength="100" autocomplete="name" />
  </div>
  <div class="field">
    <label for="email">Your email</label>
    <input id="email" name="email" type="email" required maxlength="200" autocomplete="email" />
  </div>
  <div class="field">
    <label for="message">Message</label>
    <textarea id="message" name="message" required maxlength="5000" rows="8"></textarea>
  </div>
  <div class="honeypot" aria-hidden="true">
    <label for="hp_phone">Leave this field empty</label>
    <input id="hp_phone" name="hp_phone" type="text" tabindex="-1" autocomplete="off" />
  </div>
  <button type="submit" class="primary">Send message</button>
</form>

<p class="muted">
  We don't share your message with anyone outside the project. See
  the <a href="/privacy">Privacy Policy</a> for what's collected and
  how long it's kept.
</p>
`,
  });
}

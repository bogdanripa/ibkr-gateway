// POST /contact/submit — public contact-form endpoint.
//
// Validates the form, writes the message to Firestore
// (ibkr_contact_messages), and redirects to /contact/thanks. No
// authentication — anyone on the internet can submit. The honeypot
// field catches the laziest bots; we accept-then-drop instead of
// 4xx-ing so the bot doesn't learn the field is a trap.
//
// Persistence is in Firestore so messages survive restarts and
// can be triaged in the Firebase console. There is no UI surface
// for the inbox.

import { Router } from "express";
import express from "express";
import { Timestamp } from "@google-cloud/firestore";
import { contactMessagesCol } from "./firestore.js";
import { logError } from "./logging.js";

const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const contact: Router = Router();

contact.post(
  "/contact/submit",
  express.urlencoded({ extended: false, limit: "32kb" }),
  async (req, res) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      const email = String(req.body?.email ?? "").trim();
      const message = String(req.body?.message ?? "").trim();
      const honeypot = String(req.body?.hp_phone ?? "").trim();

      // Honeypot tripped — silently drop and pretend it worked.
      if (honeypot) {
        return res.redirect(303, "/contact-thanks");
      }

      // Server-side validation. The HTML form has matching attributes
      // (required, type=email, maxlength) so reaching this path means
      // the submitter bypassed the browser — bail with a plain 400.
      if (!name || name.length > MAX_NAME) {
        return res.status(400).type("text").send("Invalid name.");
      }
      if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
        return res.status(400).type("text").send("Invalid email.");
      }
      if (!message || message.length > MAX_MESSAGE) {
        return res.status(400).type("text").send("Invalid message.");
      }

      await contactMessagesCol.add({
        ts: Timestamp.now(),
        name,
        email,
        message,
        ip: req.ip ?? null,
        user_agent: req.get("user-agent") ?? null,
      });

      res.redirect(303, "/contact-thanks");
    } catch (err) {
      await logError({
        source: "console-api",
        code: "CONTACT_SUBMIT_FAIL",
        error: err,
      }).catch(() => undefined);
      res.status(500).type("text").send(
        "Sorry — we couldn't save your message. Please try again in a minute.",
      );
    }
  },
);

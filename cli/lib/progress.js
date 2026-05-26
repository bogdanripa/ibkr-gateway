// Single-line rewriting progress indicator. CLI-only.
//
// const p = new Progress();
// p.step('launching chromium');
// p.step('opening login page');
// p.succeed('signed in');         // or p.fail('refused: …')
//
// In a TTY the step messages overwrite each other on the same line.
// Without a TTY (CI, piped output) each step is printed on its own
// line so logs are still useful.

import { stderr } from 'node:process';

export class Progress {
  constructor({ tty = !!stderr.isTTY, prefix = '  · ' } = {}) {
    this.tty = tty;
    this.prefix = prefix;
    this._lastLen = 0;
    this._active = false;
  }

  _clear() {
    if (!this.tty || !this._lastLen) return;
    stderr.write('\r' + ' '.repeat(this._lastLen) + '\r');
    this._lastLen = 0;
  }

  step(msg) {
    if (!this.tty) { stderr.write(`${this.prefix}${msg}\n`); return; }
    this._clear();
    const line = `${this.prefix}${msg}`;
    stderr.write(line);
    this._lastLen = line.length;
    this._active = true;
  }

  // End the run with a green checkmark line (or red x via .fail()).
  succeed(msg) { this._finish('✓ ' + msg); }
  fail(msg) { this._finish('✗ ' + msg); }
  // Just clear without printing a terminator.
  clear() { this._clear(); this._active = false; }

  _finish(line) {
    if (this.tty) this._clear();
    stderr.write(line + '\n');
    this._active = false;
  }
}

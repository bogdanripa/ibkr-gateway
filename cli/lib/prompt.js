// readline-based prompts. CLI-only.
//
// We don't use `rl.question` because Node's readline has a long-
// standing issue where consecutive question() calls hang under piped
// stdin (https://github.com/nodejs/node/issues/42866 and friends).
// Instead we subscribe to `line` events once and serve them from a
// queue.

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

let _rl = null;
let _closed = false;
const _lineQueue = [];      // lines received but not yet consumed
const _waiters = [];        // pending ask() resolvers, FIFO

function ensureRl() {
  if (_rl) return _rl;
  _rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  _rl.on('line', (line) => {
    if (_waiters.length) _waiters.shift()((line ?? '').trim());
    else _lineQueue.push((line ?? '').trim());
  });
  _rl.on('close', () => {
    _closed = true;
    // Resolve every pending waiter with '' so callers can detect EOF.
    while (_waiters.length) _waiters.shift()('');
  });
  return _rl;
}

// One-shot text prompt. Returns '' on EOF.
export function ask(question) {
  ensureRl();
  // Write the prompt directly so it works even when readline is set
  // to non-terminal mode (in which case `rl.question` wouldn't print).
  if (question) stdout.write(question);
  return new Promise((resolve) => {
    if (_lineQueue.length) return resolve(_lineQueue.shift());
    if (_closed) return resolve('');
    _waiters.push(resolve);
  });
}

// Masked password.
//
// Subtle: a readline interface with terminal=true installs its own
// keypress decoder that echoes characters. Just pausing it isn't
// enough — the keypress handler keeps writing each char to stdout
// while we'd also be writing a `*`, giving "a*b*c*…" output. So we
// fully tear the readline down for the duration of the password and
// recreate it lazily on the next ask().
//
// Falls back to plaintext on non-TTY (CI / piped input).
export function askPassword(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) return ask(question).then(resolve, reject);

    if (_rl) {
      _rl.close();
      _rl = null;
      _closed = false;     // ensure ensureRl() creates a fresh one next time
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
    };
    const onData = (ch) => {
      if (ch === '') { cleanup(); stdout.write('\n'); reject(new Error('cancelled')); return; }
      if (ch === '\r' || ch === '\n') { cleanup(); stdout.write('\n'); resolve(buf); return; }
      if (ch === '' || ch === '\b') { if (buf.length) { buf = buf.slice(0, -1); stdout.write('\b \b'); } return; }
      buf += ch; stdout.write('*');
    };
    stdin.on('data', onData);
  });
}

export async function yesNo(question, { defaultYes = false } = {}) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const a = (await ask(`${question} ${hint} `)).toLowerCase();
  if (!a) return defaultYes;
  return /^y(es)?$/.test(a);
}

export async function menu(title, options) {
  console.log('');
  console.log(`── ${title} ──`);
  for (const o of options) console.log(`  ${o.key}. ${o.label}`);
  return ask('> ');
}

export function closePrompts() { if (_rl && !_closed) _rl.close(); }

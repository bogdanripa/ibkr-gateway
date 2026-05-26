// Public surface of the IBKR client module. Consumers (CLIs, web
// gateways, tests) import from here:
//
//   import { IbkrClient, IbkrError } from '../lib/ibkr/index.js';
//
// Implementation details (Playwright login driver, SHA-1 helpers,
// HTTP plumbing) are private to this directory.

export { IbkrClient, IbkrError } from './client.js';
export { EmailVerificationRequiredError } from './browser-login.js';

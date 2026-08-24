#!/usr/bin/env node
import process from 'node:process';

import { describeError } from './diagnostics.js';
import { writeToStandardError } from './logger.js';
import { main } from './run.js';
import { CONNECTOR_NAME } from './version.js';

/**
 * The executable `package.json`'s `bin` points at.
 *
 * Deliberately the whole of it. Everything with a decision in it lives in
 * `run.ts`, because a module carrying a hashbang cannot be imported by a test —
 * the `#!` line is a syntax error anywhere a module is wrapped rather than
 * executed — and a module that cannot be imported cannot be proved. What is
 * left here is the hashbang itself, which `cli.test.ts` pins, and the two
 * process-level obligations nothing above this can discharge: setting the exit
 * code, and making sure the promise is not left floating.
 *
 * `tsc` preserves a leading hashbang into `dist/cli.js`, so no bundler or
 * post-processing step stands between this line and the published artefact.
 */

void main()
  .catch((error: unknown): number => {
    // `main` handles its own failures, so arriving here means a defect in
    // `main` itself. The line is assembled by hand rather than through the
    // logger, because the logger is one of the things that could have failed —
    // and it still goes to file descriptor 2, never to stdout, because stdout
    // is the JSON-RPC channel whatever else has gone wrong.
    const record = {
      level: 'error',
      time: new Date().toISOString(),
      name: CONNECTOR_NAME,
      msg: 'the connector failed unexpectedly',
      reason: describeError(error),
    };
    writeToStandardError(`${JSON.stringify(record)}\n`);
    return 1;
  })
  .then((exitCode: number) => {
    // Not `process.exit`: the transports are already closed by the time this
    // runs, so the process leaves on its own once the loop is empty — and
    // without truncating anything still on its way to a file descriptor.
    process.exitCode = exitCode;
  });

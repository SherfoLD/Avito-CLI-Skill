/**
 * Five classes, five distinguishable exit codes, so a caller can tell "you
 * passed bad arguments" from "Avito answered with a shape we refuse to guess
 * about" without parsing English.
 *
 * A command either returns correct data or throws one of these. There is no
 * third outcome — no fallback value, no sentinel field, no empty list standing
 * in for a failed fetch.
 */

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,      // bad arguments / command misuse
  EMPTY_RESULT: 66,    // the request succeeded and there is nothing to return
  TEMPFAIL: 75,        // timeout — the call may be repeated by a human, never by us
  ACCESS: 77,          // Avito is not answering this session — a person has to look
};

export class CliError extends Error {
  constructor(code, message, { hint, exitCode = EXIT_CODES.GENERIC_ERROR, details } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** The caller passed something this command cannot act on. Thrown before the network. */
export class ArgumentError extends CliError {
  constructor(message, hint) {
    super('ARGUMENT', message, { hint, exitCode: EXIT_CODES.USAGE_ERROR });
  }
}

/**
 * The request went out and what came back cannot be decoded into the declared
 * contract: an HTTP refusal, a challenge, a drifted response shape, or a
 * postcondition that did not hold. Never soften this into a partial answer.
 */
export class CommandExecutionError extends CliError {
  constructor(message, hint, details) {
    super('COMMAND_EXEC', message, { hint, exitCode: EXIT_CODES.GENERIC_ERROR, details });
  }
}

/**
 * The request succeeded and Avito genuinely has nothing to return.
 *
 * `reason` is not decoration and does not belong in a hint: an empty answer is
 * only actionable if it says which emptiness it is. "every listing on this page
 * (2) is reserved" and "no listings match the query" are the same exit code and
 * completely different situations, and the caller has no second request that
 * would tell them apart.
 */
export class EmptyResultError extends CliError {
  constructor(command, reason) {
    super('EMPTY_RESULT', reason ? String(reason) : `${command} returned no data`, {
      exitCode: EXIT_CODES.EMPTY_RESULT,
    });
    this.command = command;
  }
}

/**
 * Avito answered, but not with data: a rate limit, a verification page, a
 * document carrying no state at all. Its own exit code because it is the one
 * refusal a caller must not retry and cannot fix — the browser has to be opened
 * by the person who owns it.
 */
export class AccessError extends CliError {
  constructor(message, hint, details) {
    super('ACCESS', message, {
      hint: hint ?? 'Open www.avito.ru in the same browser and check what it is asking for.',
      exitCode: EXIT_CODES.ACCESS,
      details,
    });
  }
}

/** A browser or network operation did not answer in time. */
export class TimeoutError extends CliError {
  constructor(label, seconds, hint) {
    super('TIMEOUT', `${label} timed out after ${seconds}s`, {
      hint,
      exitCode: EXIT_CODES.TEMPFAIL,
    });
  }
}

export function exitCodeFor(error) {
  return error instanceof CliError ? error.exitCode : EXIT_CODES.GENERIC_ERROR;
}

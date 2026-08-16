/**
 * A refusal a browser half returns rather than throws.
 *
 * Anything Avito is allowed to answer comes back as this envelope; an exception
 * from a browser half means the shape was impossible and nobody planned for it.
 *
 * `stage` says how far the call got: `submit`, `schema`, `api`, `catalog`,
 * `postcondition`. `code` says what kind of refusal it was: `access`, `http`,
 * `parse`, `missing`, `shape`, `drift`, `empty`, `transport`, `content_type`.
 * The node half maps the pair onto one of the four typed errors.
 */
export function fail(stage, code, message, details = {}) {
  return {
    success: false,
    stage,
    code,
    message,
    details,
  };
}

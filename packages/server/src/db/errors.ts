/** An error caused by bad input (admin or client), safe to show to the caller. */
export class TubError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "TubError"
  }
}

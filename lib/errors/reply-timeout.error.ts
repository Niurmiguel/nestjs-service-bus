/**
 * The error a `send()` Observable fails with when its reply has not completed
 * within the client's `replyTimeoutInMs`.
 */
export class ReplyTimeoutError extends Error {
  readonly name = "ReplyTimeoutError";

  constructor(
    /** The queue the reply was expected on. */
    readonly replyTo: string,
    readonly timeoutInMs: number
  ) {
    super(`No complete reply on "${replyTo}" within ${timeoutInMs} ms`);
  }
}

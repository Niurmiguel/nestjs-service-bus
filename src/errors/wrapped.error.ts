export class WrappedError extends Error {
  static wrapPromise(error: Error) {
    throw new WrappedError(error);
  }

  get name(): string {
    return this.error.name;
  }

  get message(): string {
    return this.error.message;
  }

  get stack(): string {
    return this.error.stack;
  }

  set name(value: string) {
    this.error.name = value;
  }

  set message(value: string) {
    this.error.message = value;
  }

  set stack(value: string) {
    this.error.stack = value;
  }

  constructor(public readonly error: Error) {
    super();
  }
}

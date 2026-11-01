export class RebuildMismatchError extends Error {
  constructor(message = "The timing index does not match the processed audio") {
    super(message);
    this.name = "RebuildMismatchError";
  }
}

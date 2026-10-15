export class FetchTimeoutError extends Error {
  constructor(message = "Upstream request timed out") {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export class ChallengeError extends Error {
  constructor(message = "Upstream challenge could not be solved") {
    super(message);
    this.name = "ChallengeError";
  }
}

export class SiteFetchError extends Error {
  constructor(message = "Upstream request failed", options?: ErrorOptions) {
    super(message, options);
    this.name = "SiteFetchError";
  }
}

export const errorFromWire = (name: string, message: string): Error => {
  if (name === "FetchTimeoutError") return new FetchTimeoutError(message);
  if (name === "ChallengeError") return new ChallengeError(message);
  if (name === "SiteFetchError") return new SiteFetchError(message);
  const error = new Error(message);
  error.name = name;
  return error;
};

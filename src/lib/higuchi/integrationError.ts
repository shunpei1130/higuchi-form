/** Shared error contract without imports, so provider modules never depend on their own export barrel. */
export class HiguchiIntegrationError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "HiguchiIntegrationError";
  }
}

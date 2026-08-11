/**
 * The one failure type every module here throws, so `cli.ts` can tell a refusal this tool
 * decided on — which is already phrased for the operator and needs no decoration — from a
 * crash, whose message would otherwise reach them raw.
 */
export class PublishCleanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublishCleanError";
  }
}

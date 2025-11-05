const tracking: { event: string; properties: any }[] = ((
  globalThis as any
).tracking = []);

export const sandboxTelemetry = {
  track: () => {},
};

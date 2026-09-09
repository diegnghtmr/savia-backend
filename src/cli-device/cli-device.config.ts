export class CliDeviceConfig {
  private constructor(public readonly verificationUri: string) {}
  public static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): CliDeviceConfig {
    const value = environment.CLI_DEVICE_VERIFICATION_URI?.trim();
    if (!value)
      throw new Error(
        'CLI configuration CLI_DEVICE_VERIFICATION_URI must be a non-empty URL.',
      );
    const uri = new URL(value);
    if (!['http:', 'https:'].includes(uri.protocol))
      throw new Error(
        'CLI configuration CLI_DEVICE_VERIFICATION_URI must be an HTTP URL.',
      );
    return new CliDeviceConfig(uri.toString());
  }
}

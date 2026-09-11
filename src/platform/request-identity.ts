export interface RequestIdentity {
  readonly subject: string;
  readonly authMethod?: 'session' | 'cli_token';
}

export interface SbEmitterMetadataOptions {
  name: string;

  /**
   * The unique id of the client that this emitter should use as the underlying emitter.
   * This should match the client name defined in `SgClientOptions.name`.
   *
   * By default `SgClientOptions.name` is not set, which is the identifier for the default client.
   * A multi-client environment is not required in most of the scenarios, if that is the case do not set this value.
   */
  clientId?: string;
}

export interface SbTopicMetadataOptions extends SbEmitterMetadataOptions {
  provision?: any; // todo - types
}

export interface SbEmitterTypeMap {
  topic: SbTopicMetadataOptions;
}

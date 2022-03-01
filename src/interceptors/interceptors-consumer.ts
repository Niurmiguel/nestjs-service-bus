import { SbContext } from '../service-bus.context';

export abstract class InterceptorsConsumer {
  abstract intercept(
    context: SbContext,
    next: () => Promise<unknown>,
  ): Promise<unknown>;
}

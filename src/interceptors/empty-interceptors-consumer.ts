import { InterceptorsConsumer } from './interceptors-consumer';
import { SbContext } from '../service-bus.context';

export class EmptyInterceptorsConsumer extends InterceptorsConsumer {
  async intercept(context: SbContext, next: () => Promise<unknown>) {
    return next();
  }
}

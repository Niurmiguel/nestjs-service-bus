import { CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';

import { SbContext } from '../service-bus.context';

export interface SbInterceptor<T = any, R = any> {
  intercept(
    context: SbContext,
    next: CallHandler<T>,
  ): Observable<R> | Promise<Observable<R>>;
}

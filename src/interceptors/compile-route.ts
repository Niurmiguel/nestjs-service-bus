import { STATIC_CONTEXT } from '@nestjs/core/injector/constants';

import { SB_INTERCEPTORS_METADATA } from '../constants';
import { SbInterceptorMetadataForTarget } from '../decorators';
import { SbInterceptor } from '../interfaces';

import { EmptyInterceptorsConsumer } from './empty-interceptors-consumer';
import { StaticInterceptorsConsumer } from './static-interceptors-consumer';
import { InterceptorsConsumer } from './interceptors-consumer';

function compileRoute(routeInstructions: any) {
  const { key, instanceWrapper } = routeInstructions;
  const ctrlInterceptors: SbInterceptorMetadataForTarget = Reflect.getMetadata(
    SB_INTERCEPTORS_METADATA,
    instanceWrapper.metatype.prototype,
  );
  const rawInterceptors = (ctrlInterceptors && ctrlInterceptors.get(key)) || [];

  const dynamicRefs: number[] = [];
  const interceptors = rawInterceptors.map((interceptor, index) => {
    if (typeof interceptor === 'function') {
      const interceptorWrapper = instanceWrapper.host.injectables.get(
        interceptor.name,
      );
      const isStatic = interceptorWrapper.isDependencyTreeStatic();
      if (!isStatic) {
        dynamicRefs.push(index);
      }
      const resolving =
        interceptorWrapper.getInstanceByContextId(STATIC_CONTEXT);
      return resolving.instance as SbInterceptor;
    } else {
      return interceptor;
    }
  });

  return {
    isStatic: dynamicRefs.length === 0,
    hasInterceptions: interceptors.length > 0,
    interceptors,
    dynamicRefs,
  };
}

export function createConsumer(routeInstructions: any): InterceptorsConsumer {
  const compiled = compileRoute(routeInstructions);

  if (!compiled.hasInterceptions) {
    return new EmptyInterceptorsConsumer();
  } else if (compiled.isStatic) {
    return new StaticInterceptorsConsumer(compiled.interceptors);
  } else {
    throw new Error('Dynamic interceptors are not yet supported.');
  }
}

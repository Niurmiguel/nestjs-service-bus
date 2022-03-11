export * from "./service-bus-module.interface";
export * from "./subscriber-routing.interface";
export * from "./service-bus.interface";
export * from "./subscriber.interface";
export * from "./emitter.interface";

export type MetaOrMetaFactory<T> = T | ((helper?: any) => T | Promise<T>);

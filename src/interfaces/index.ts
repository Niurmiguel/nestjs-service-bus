export * from "./subscriber-routing.interface";
export * from "./subscriber.interface";
export * from "./emitter.interface";
export * from "./sb-module.interface";

export type MetaOrMetaFactory<T> = T | ((helper?: any) => T | Promise<T>);

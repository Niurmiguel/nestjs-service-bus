export * from "./service-bus-module.interface";
export * from "./subscriber.interface";

export type MetaOrMetaFactory<T> = T | ((helper?: any) => T | Promise<T>);

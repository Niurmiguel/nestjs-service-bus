export * from "./azure-service-bus-module.interface";
export * from "./azure-service-bus.interface";
export * from "./subscriber.interface";

export type MetaOrMetaFactory<T> = T | ((helper?: any) => T | Promise<T>);

import { Module } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";

@Module({})
export class ServiceBusModule {
  constructor(readonly modulesContainer: ModulesContainer) {}
}

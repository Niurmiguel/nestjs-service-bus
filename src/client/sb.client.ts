import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';
import { SbOptions } from '../interfaces';

export class SbClient extends ClientProxy {
  constructor(protected readonly options: SbOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  connect(): Promise<any> {
    throw new Error('Method not implemented.');
  }
  close() {
    throw new Error('Method not implemented.');
  }
  protected publish(
    packet: ReadPacket<any>,
    callback: (packet: WritePacket<any>) => void,
  ): () => void {
    throw new Error('Method not implemented.');
  }
  protected dispatchEvent<T = any>(packet: ReadPacket<any>): Promise<T> {
    throw new Error('Method not implemented.');
  }
}

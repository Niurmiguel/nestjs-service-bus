export const SB_SUBSCRIBER_METADATA = "service_bus_subscriber_metadata";

/**
 * The `transportId` of `AzureServiceBusServer`, which `@Subscription()` and
 * `@Queue()` declare as their transport. In a hybrid application NestJS then
 * registers those handlers only on this transport's servers (and on servers
 * that declare no `transportId`), and handlers declared for another transport
 * (e.g. `@MessagePattern(pattern, Transport.TCP)`) never reach this one.
 *
 * A registered symbol (`Symbol.for()`), so that it is the same even when an
 * application ends up with two copies of this package.
 */
export const AZURE_SERVICE_BUS_TRANSPORT: unique symbol = Symbol.for(
  "@niur/nestjs-service-bus/transport"
);

/**
 * Key of the handler extras that `@Subscription()` and `@Queue()` set, so the
 * server knows those handlers are its own even when their pattern cannot be
 * read (and must fail) rather than belonging to another transport.
 */
export const SB_SUBSCRIBER_EXTRA = "nestjs-sb-subscriber";

/*
 * Request-response over Service Bus. The client sends the request to
 * `<entity>` with `replyTo: "<entity>.reply"`; the server answers on that
 * queue with one message per value of the handler's response.
 */

/**
 * Application property of a request: the id its replies carry as
 * `correlationId`. The `messageId` is that id too, unless the caller set its
 * own (e.g. for duplicate detection).
 */
export const SB_REQUEST_ID_PROPERTY = "nestjs-sb-request-id";

/**
 * Application property of a reply: `"response"` (the body is a value of the
 * response), `"error"` (the body is the error) or `"none"` (no body: only the
 * end of the response). Servers before 1.2.0 do not set it, and their only
 * reply is the whole response.
 */
export const SB_REPLY_TYPE_PROPERTY = "nestjs-sb-reply-type";

/** Application property of a reply: `true` on the last reply of a request. */
export const SB_REPLY_DISPOSED_PROPERTY = "nestjs-sb-is-disposed";

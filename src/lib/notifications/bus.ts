import { EventEmitter } from "node:events";

/**
 * In-process fan-out between the emitter and the open SSE streams.
 * Kept on globalThis so a dev-server module reload does not orphan the listeners
 * of streams that are already open. Only delivers to the instance that emitted;
 * the stream's Database poll covers every other instance.
 */
const globalForBus = globalThis as unknown as { __vosNotificationBus?: EventEmitter };

export const notificationBus: EventEmitter =
    globalForBus.__vosNotificationBus ??
    (() => {
        const bus = new EventEmitter();
        bus.setMaxListeners(0);
        globalForBus.__vosNotificationBus = bus;
        return bus;
    })();

export const NOTIFICATION_EVENT = "notification";

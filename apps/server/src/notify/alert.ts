/**
 * The shape of an alert on its way out of the process.
 *
 * Raised by the device manager on its `alert` event and consumed by everything that
 * has asked to be told: browser push, and the cloud event tap. It lived in the
 * webhook module until webhooks were removed — they were the first consumer, not the
 * owner of the type.
 */
export interface OutboundAlert {
  id: string;
  timestamp: string;
  severity: string;
  type: string;
  message: string;
  detail?: string;
  channelId?: string;
  channelName?: string;
  deviceId?: string;
  deviceName?: string;
}

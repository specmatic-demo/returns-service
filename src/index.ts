import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { Kafka, type Producer } from 'kafkajs';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage
} from 'amqplib';
import type {
  ReturnDecisionRequest,
  ReturnEvaluationReply,
  ReturnEvaluationRequest,
  ReturnInitiationRequest,
  ShippingReturnedEvent,
  ReturnStatus,
  ReturnStatusChanged,
  ReturnSummary
} from './types';

const host = process.env.RETURNS_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.RETURNS_PORT || '9012', 10);
const amqpUrl = process.env.RETURNS_AMQP_URL || 'amqp://localhost:5672';
const evaluationRequestQueue = process.env.RETURN_EVALUATION_REQUEST_QUEUE || 'return.evaluation.request';
const evaluationReplyQueue = process.env.RETURN_EVALUATION_REPLY_QUEUE || 'return.evaluation.reply';
const statusChangedQueue = process.env.RETURN_STATUS_CHANGED_QUEUE || 'return.status.changed';
const orderBaseUrl = process.env.ORDER_BASE_URL || 'http://localhost:5211';
const paymentBaseUrl = process.env.PAYMENT_BASE_URL || 'http://localhost:5212';
const shippingBaseUrl = process.env.SHIPPING_BASE_URL || 'http://localhost:5213';
const kafkaBrokers = (process.env.RETURNS_KAFKA_BROKERS || 'localhost:9092')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const shippingReturnedTopic = process.env.SHIPPING_RETURNED_TOPIC || 'shipping.returned';

const app = express();
app.use(express.json({ limit: '1mb' }));

const returns = new Map<string, ReturnSummary>();
let amqpConnection: ChannelModel | null = null;
let amqpChannel: Channel | null = null;
let amqpConnected = false;
const kafka = new Kafka({
  clientId: 'returns-service-notifications',
  brokers: kafkaBrokers
});
const kafkaProducer: Producer = kafka.producer();
let kafkaConnected = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isReturnInitiationRequest(value: unknown): value is ReturnInitiationRequest {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length < 1) {
    return false;
  }

  const allowedReasonCodes = new Set(['DAMAGED', 'DEFECTIVE', 'WRONG_ITEM', 'NO_LONGER_NEEDED']);
  const itemsValid = value.items.every((item) => {
    if (!isRecord(item)) {
      return false;
    }

    return (
      typeof item.sku === 'string' &&
      typeof item.quantity === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity >= 1 &&
      typeof item.reasonCode === 'string' &&
      allowedReasonCodes.has(item.reasonCode)
    );
  });

  return (
    itemsValid &&
    typeof value.requestId === 'string' &&
    typeof value.orderId === 'string' &&
    typeof value.customerId === 'string' &&
    isIsoDateTime(value.requestedAt)
  );
}

function isReturnDecisionRequest(value: unknown): value is ReturnDecisionRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.decision === 'APPROVED' || value.decision === 'REJECTED') &&
    (typeof value.reasonCode === 'undefined' || typeof value.reasonCode === 'string') &&
    isIsoDateTime(value.decidedAt)
  );
}

function isReturnEvaluationRequest(value: unknown): value is ReturnEvaluationRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.requestId === 'string' &&
    typeof value.returnId === 'string' &&
    typeof value.orderId === 'string' &&
    typeof value.customerId === 'string' &&
    isIsoDateTime(value.requestedAt)
  );
}

function toJsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function computeRefundAmount(request: ReturnInitiationRequest): number {
  const quantity = request.items.reduce((sum, item) => sum + item.quantity, 0);
  return Number((quantity * 10).toFixed(2));
}

async function callOrderDependency(orderId: string): Promise<void> {
  await fetch(`${orderBaseUrl}/orders/${encodeURIComponent(orderId)}`).catch(() => undefined);
}

async function callShippingDependency(orderId: string): Promise<void> {
  await fetch(`${shippingBaseUrl}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId,
      destinationPostalCode: '00000'
    })
  }).catch(() => undefined);
}

async function callPaymentRefundDependency(returnSummary: ReturnSummary): Promise<void> {
  if (typeof returnSummary.refundAmount !== 'number') {
    return;
  }

  const paymentId = `pay-${returnSummary.returnId}`;
  await fetch(`${paymentBaseUrl}/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      amount: returnSummary.refundAmount,
      reason: 'RETURN_APPROVED'
    })
  }).catch(() => undefined);
}

async function ensureKafkaProducerConnected(): Promise<void> {
  if (kafkaConnected) {
    return;
  }

  await kafkaProducer.connect();
  kafkaConnected = true;
}

async function publishShippingReturnedEvent(event: ShippingReturnedEvent): Promise<void> {
  await ensureKafkaProducerConnected();
  await kafkaProducer.send({
    topic: shippingReturnedTopic,
    messages: [{ key: event.returnId, value: JSON.stringify(event) }]
  });
}

async function publishShippingReturnedEventSafe(event: ShippingReturnedEvent): Promise<void> {
  try {
    await publishShippingReturnedEvent(event);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`failed to publish shipping returned event on ${shippingReturnedTopic}: ${detail}`);
  }
}

async function declareAddress(address: string): Promise<void> {
  if (!amqpChannel) {
    return;
  }

  await amqpChannel.assertExchange(address, 'direct', { durable: false });
  await amqpChannel.assertQueue(address, { durable: false });
  await amqpChannel.bindQueue(address, address, address);
}

async function publishEvaluationReply(reply: ReturnEvaluationReply): Promise<void> {
  if (!amqpChannel) {
    return;
  }

  await declareAddress(evaluationReplyQueue);
  amqpChannel.publish(evaluationReplyQueue, evaluationReplyQueue, toJsonBuffer(reply), { persistent: false });
}

async function publishStatusChanged(event: ReturnStatusChanged): Promise<void> {
  if (!amqpChannel) {
    return;
  }

  await declareAddress(statusChangedQueue);
  amqpChannel.publish(statusChangedQueue, statusChangedQueue, toJsonBuffer(event), { persistent: false });
}

function rememberReturn(summary: ReturnSummary): void {
  returns.set(summary.returnId, summary);
}

async function processEvaluationRequest(request: ReturnEvaluationRequest): Promise<void> {
  const existing = returns.get(request.returnId) ?? {
    returnId: request.returnId,
    orderId: request.orderId,
    customerId: request.customerId,
    status: 'PENDING_REVIEW' as ReturnStatus,
    refundAmount: 10,
    updatedAt: new Date().toISOString()
  };

  const decision: ReturnStatus = request.orderId.length % 2 === 0 ? 'APPROVED' : 'REJECTED';
  const updated: ReturnSummary = {
    ...existing,
    status: decision,
    updatedAt: new Date().toISOString()
  };

  rememberReturn(updated);

  await publishEvaluationReply({
    requestId: request.requestId,
    returnId: request.returnId,
    decision,
    repliedAt: new Date().toISOString(),
    reasonCode: decision === 'REJECTED' ? 'VALIDATION_FAILED' : undefined
  });

  await publishStatusChanged({
    eventId: randomUUID(),
    returnId: request.returnId,
    fromStatus: existing.status,
    toStatus: updated.status,
    changedAt: new Date().toISOString()
  });
}

async function startAmqp(): Promise<void> {
  amqpConnection = await connect(amqpUrl);
  amqpChannel = await amqpConnection.createChannel();
  await declareAddress(evaluationRequestQueue);
  await declareAddress(evaluationReplyQueue);
  await declareAddress(statusChangedQueue);

  amqpConnected = true;
  console.log(`[amqp] connected to ${amqpUrl}`);

  await amqpChannel.consume(evaluationRequestQueue, (message: ConsumeMessage | null) => {
    if (!message) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.content.toString('utf8')) as unknown;
    } catch {
      amqpChannel?.ack(message);
      return;
    }

    if (!isReturnEvaluationRequest(payload)) {
      amqpChannel?.ack(message);
      return;
    }

    void processEvaluationRequest(payload)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`failed to process evaluation request: ${detail}`);
      })
      .finally(() => amqpChannel?.ack(message));
  });

  setInterval(() => {
    const requestId = randomUUID();
    void publishEvaluationReply({
      requestId,
      returnId: randomUUID(),
      decision: 'APPROVED',
      repliedAt: new Date().toISOString()
    }).catch(() => undefined);

    void publishStatusChanged({
      eventId: randomUUID(),
      returnId: randomUUID(),
      fromStatus: 'PENDING_REVIEW',
      toStatus: 'APPROVED',
      changedAt: new Date().toISOString()
    }).catch(() => undefined);
  }, 3000);
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    amqpConnected,
    kafkaConnected
  });
});

app.post('/returns', async (req: Request, res: Response) => {
  if (!isReturnInitiationRequest(req.body)) {
    res.status(400).json({ error: 'Invalid return request' });
    return;
  }

  try {
    await callOrderDependency(req.body.orderId);

    const summary: ReturnSummary = {
      returnId: randomUUID(),
      orderId: req.body.orderId,
      customerId: req.body.customerId,
      status: 'PENDING_REVIEW',
      refundAmount: computeRefundAmount(req.body),
      updatedAt: new Date().toISOString()
    };

    rememberReturn(summary);

    await publishShippingReturnedEventSafe({
      eventId: randomUUID(),
      orderId: summary.orderId,
      shipmentId: `shipment-${summary.orderId}`,
      returnId: summary.returnId,
      status: 'RETURN_INITIATED',
      title: 'Return initiated',
      body: `Return ${summary.returnId} initiated for order ${summary.orderId}`,
      priority: 'NORMAL',
      occurredAt: new Date().toISOString()
    });

    res.status(202).json(summary);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: detail });
  }
});

app.get('/returns/:returnId', (req: Request, res: Response) => {
  const returnId = decodeURIComponent(req.params.returnId);
  const summary = returns.get(returnId) ?? {
    returnId,
    orderId: `order-${returnId}`,
    customerId: `customer-${returnId}`,
    status: 'PENDING_REVIEW',
    updatedAt: new Date().toISOString()
  };

  res.status(200).json(summary);
});

app.post('/returns/:returnId/decision', async (req: Request, res: Response) => {
  if (!isReturnDecisionRequest(req.body)) {
    res.status(400).json({ error: 'Invalid decision payload' });
    return;
  }

  const returnId = decodeURIComponent(req.params.returnId);
  const existing = returns.get(returnId) ?? {
    returnId,
    orderId: `order-${returnId}`,
    customerId: `customer-${returnId}`,
    status: 'PENDING_REVIEW' as ReturnStatus,
    refundAmount: 10,
    updatedAt: new Date().toISOString()
  };

  const nextStatus: ReturnStatus = req.body.decision === 'APPROVED' ? 'REFUND_INITIATED' : 'REJECTED';
  const updated: ReturnSummary = {
    ...existing,
    status: nextStatus,
    updatedAt: new Date().toISOString()
  };

  try {
    if (req.body.decision === 'APPROVED') {
      await callPaymentRefundDependency(updated);
      await callShippingDependency(updated.orderId);
    }

    rememberReturn(updated);

    await publishStatusChanged({
      eventId: randomUUID(),
      returnId,
      fromStatus: existing.status,
      toStatus: updated.status,
      changedAt: new Date().toISOString()
    });

    await publishShippingReturnedEventSafe({
      eventId: randomUUID(),
      orderId: updated.orderId,
      shipmentId: `shipment-${updated.orderId}`,
      returnId: updated.returnId,
      status: req.body.decision === 'APPROVED' ? 'COMPLETED' : 'FAILED',
      title: req.body.decision === 'APPROVED' ? 'Return completed' : 'Return failed',
      body:
        req.body.decision === 'APPROVED'
          ? `Return ${updated.returnId} completed for order ${updated.orderId}`
          : `Return ${updated.returnId} failed for order ${updated.orderId}`,
      priority: req.body.decision === 'APPROVED' ? 'NORMAL' : 'HIGH',
      occurredAt: new Date().toISOString()
    });

    res.status(200).json(updated);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: detail });
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

void startAmqp().catch((error: unknown) => {
  amqpConnected = false;
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[amqp] startup failed: ${detail}`);
});

app.listen(port, host, () => {
  console.log(`returns-service listening on http://${host}:${port}`);
});

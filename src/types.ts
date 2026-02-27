export type ReturnStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'REFUND_INITIATED' | 'COMPLETED';
export type Decision = 'APPROVED' | 'REJECTED';

export interface ReturnLineItem {
  sku: string;
  quantity: number;
  reasonCode: 'DAMAGED' | 'DEFECTIVE' | 'WRONG_ITEM' | 'NO_LONGER_NEEDED';
}

export interface ReturnInitiationRequest {
  requestId: string;
  orderId: string;
  customerId: string;
  items: ReturnLineItem[];
  requestedAt: string;
}

export interface ReturnDecisionRequest {
  decision: Decision;
  reasonCode?: string;
  decidedAt: string;
}

export interface ReturnSummary {
  returnId: string;
  orderId: string;
  customerId: string;
  status: ReturnStatus;
  refundAmount?: number;
  updatedAt: string;
}

export interface ReturnEvaluationRequest {
  requestId: string;
  returnId: string;
  orderId: string;
  customerId: string;
  requestedAt: string;
}

export interface ReturnEvaluationReply {
  requestId: string;
  returnId: string;
  decision: Decision;
  reasonCode?: string;
  repliedAt: string;
}

export interface ReturnStatusChanged {
  eventId: string;
  returnId: string;
  fromStatus: string;
  toStatus: string;
  changedAt: string;
}

export type ShippingReturnedStatus = 'RETURN_INITIATED' | 'IN_TRANSIT' | 'RECEIVED' | 'COMPLETED' | 'FAILED';

export interface ShippingReturnedEvent {
  eventId: string;
  orderId: string;
  shipmentId: string;
  returnId: string;
  status: ShippingReturnedStatus;
  title: string;
  body: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
  occurredAt: string;
}

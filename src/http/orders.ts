import { Router } from 'express';
import type { Db } from '../db.js';
import { getJob, getOrder } from '../repo.js';

/** Read-only status of one order and its job (no auth: local/demo use only). */
export function ordersRouter({ db }: { db: Db }): Router {
  const router = Router();

  router.get('/orders/:orderId', (req, res) => {
    const order = getOrder(db, req.params.orderId);
    if (!order) {
      res.status(404).json({ error: 'order not found' });
      return;
    }
    const job = getJob(db, order.order_id);
    res.json({
      orderId: order.order_id,
      status: order.status,
      shipmentId: order.shipment_id,
      duplicateShipments: order.duplicate_shipments,
      createdAt: new Date(order.created_at).toISOString(),
      updatedAt: new Date(order.updated_at).toISOString(),
      job: job && {
        status: job.status,
        attempts: job.attempts,
        rateLimitHits: job.rate_limit_hits,
        reconcileRequeues: job.reconcile_requeues,
        lastError: job.last_error,
        runAt: new Date(job.run_at).toISOString(),
      },
    });
  });

  return router;
}

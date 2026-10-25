import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { adjustAllocation, PoolError } from "../utils/inventory-pool.server";
import db from "../db.server";

const ORDER_WEBHOOK_TOPIC = "orders/create";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, shop } = await authenticate.webhook(request);

  console.log(
    `Received ${ORDER_WEBHOOK_TOPIC} webhook for ${shop}`,
  );

  try {
    const { order } = payload;

    if (!order || !order.lineItems) {
      console.log("Order webhook received without line items");
      return new Response();
    }

    // Process each line item for inventory allocation
    const allocationPromises = order.lineItems.map(
      async (lineItem: any) => {
        const variantId = lineItem.variant.id;
        const quantity = lineItem.quantity;

        // Find the inventory pool for this shop and product
        const productId = lineItem.productId;
        const pool = await db.inventoryPool.findFirst({
          where: {
            shop,
            productId,
          },
        });

        if (!pool) {
          // No pool for this product/shop; skip allocation
          return { success: true, variantId, allocated: 0 };
        }

        // Check if this variant is in the pool
        const poolVariant = await db.inventoryPoolVariant.findFirst({
          where: {
            poolId: pool.id,
            variantId,
          },
        });

        if (!poolVariant) {
          // Variant is not in this pool; skip allocation
          return { success: true, variantId, allocated: 0 };
        }

        try {
          // Negative quantity = reservation from pool
          const result = await adjustAllocation(pool.id, variantId, -quantity);

          return {
            success: result.success,
            variantId,
            allocated: quantity,
            remaining: result.remaining,
          };
        } catch (error) {
          if (error instanceof PoolError) {
            console.error(
              `Allocation failed for variant ${variantId}: ${error.message}`,
            );
            return { success: false, variantId, error: error.message };
          }
          throw error;
        }
      },
    );

    const results = await Promise.all(allocationPromises);

    // Check if any allocation failed
    const anyFailed = results.some((r) => r.success === false);

    if (anyFailed) {
      console.log(
        `Inventory allocation failed for some items in order ${order.id}`,
      );
    }

    console.log(
      `Inventory allocation processed for order ${order.id}: ${results.length} items`,
    );

    return new Response();
  } catch (error) {
    console.error("Order webhook processing error:", error);
    throw error;
  }
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma  from "../db.server";
import {
  checkAvailability,
  PoolError,
} from "../utils/inventory-pool.server";
import { z } from "zod";

const requestSchema = z.object({
  variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  requestedQty: z.coerce.number().int().positive().max(1000000),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { session } = await authenticate.admin(request);
    const body: unknown = await request.json();
    const input = requestSchema.safeParse(body);

    if (!input.success) {
      return Response.json(
        { error: "Provide a valid variantId and positive requestedQty." },
        { status: 400 },
      );
    }

    const poolVariant = await prisma.inventoryPoolVariant.findFirst({
      where: {
        variantId: input.data.variantId,
        pool: { shop: session.shop },
      },
      include: { pool: true },
    });

    if (!poolVariant) {
      return Response.json(
        { error: "No inventory pool found for this variant." },
        { status: 404 },
      );
    }

    const availability = await checkAvailability(
      poolVariant.poolId,
      input.data.variantId,
      input.data.requestedQty,
    );

    return Response.json(availability);
  } catch (error) {
    if (error instanceof PoolError) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof Response) {
      throw error;
    }

    console.error("Inventory availability check failed:", error);
    return Response.json(
      { error: "Unable to check inventory availability." },
      { status: 500 },
    );
  }
}


import { z } from "zod";
import prisma  from "../db.server";

export const createPoolSchema = z.object({
  shop: z.string().min(1),
  productId: z.string().min(1),
  totalQty: z.number().int().nonnegative(),
  variantGids: z.array(z.string().min(1)).min(1),
});

export const adjustAllocationSchema = z.object({
  poolId: z.string().min(1),
  variantId: z.string().min(1),
  delta: z.number().int().refine((value) => value !== 0),
});

export class PoolError extends Error {
  constructor(
    public readonly code:
      | "POOL_NOT_FOUND"
      | "VARIANT_NOT_IN_POOL"
      | "INSUFFICIENT_INVENTORY"
      | "POOL_EXISTS"
      | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "PoolError";
  }
}

export type PoolWithVariants = {
  id: string;
  shop: string;
  productId: string;
  totalQty: number;
  variants: {
    id: string;
    variantId: string;
    allocatedQty: number;
  }[];
};

export async function createPool(
  shop: string,
  productId: string,
  totalQty: number,
  variantGids: string[],
): Promise<PoolWithVariants> {
  const parsed = createPoolSchema.safeParse({
    shop,
    productId,
    totalQty,
    variantGids,
  });

  if (!parsed.success) {
    throw new PoolError("INVALID_INPUT", parsed.error.message);
  }

  const uniqueVariantGids = [...new Set(parsed.data.variantGids)];

  if (uniqueVariantGids.length !== parsed.data.variantGids.length) {
    throw new PoolError("INVALID_INPUT", "Duplicate variant IDs are not allowed.");
  }

  const existing = await prisma.inventoryPool.findUnique({
    where: {
      shop_productId: {
        shop: parsed.data.shop,
        productId: parsed.data.productId,
      },
    },
  });

  if (existing) {
    throw new PoolError("POOL_EXISTS", "An inventory pool already exists for this product.");
  }

  // Shopify product/variant ownership must also be verified by the
  // authenticated route before this function is called.
  try {
    return await prisma.inventoryPool.create({
      data: {
        shop: parsed.data.shop,
        productId: parsed.data.productId,
        totalQty: parsed.data.totalQty,
        variants: {
          create: uniqueVariantGids.map((variantId) => ({
            variantId,
            allocatedQty: 0,
          })),
        },
      },
      include: { variants: true },
    });
  } catch (error) {
    // The unique database constraint protects against duplicate creation
    // even when two requests race.
    const existingAfterFailure = await prisma.inventoryPool.findUnique({
      where: {
        shop_productId: {
          shop: parsed.data.shop,
          productId: parsed.data.productId,
        },
      },
    });

    if (existingAfterFailure) {
      throw new PoolError("POOL_EXISTS", "An inventory pool already exists for this product.");
    }

    throw error;
  }
}

export async function getPool(
  shop: string,
  productId: string,
): Promise<PoolWithVariants | null> {
  return prisma.inventoryPool.findUnique({
    where: {
      shop_productId: { shop, productId },
    },
    include: { variants: true },
  });
}

export async function checkAvailability(
  poolId: string,
  variantId: string,
  requestedQty: number,
): Promise<{ ok: boolean; remaining: number }> {
  if (!Number.isSafeInteger(requestedQty) || requestedQty < 1) {
    throw new PoolError("INVALID_INPUT", "Requested quantity must be a positive integer.");
  }

  const pool = await prisma.inventoryPool.findUnique({
    where: { id: poolId },
    include: { variants: true },
  });

  if (!pool) {
    throw new PoolError("POOL_NOT_FOUND", "Inventory pool not found.");
  }

  const variant = pool.variants.find((item) => item.variantId === variantId);

  if (!variant) {
    throw new PoolError("VARIANT_NOT_IN_POOL", "Variant does not belong to this inventory pool.");
  }

  const allocated = pool.variants.reduce(
    (total, item) => total + item.allocatedQty,
    0,
  );
  const remaining = Math.max(0, pool.totalQty - allocated);

  return {
    ok: remaining >= requestedQty,
    remaining,
  };
}

export async function adjustAllocation(
  poolId: string,
  variantId: string,
  delta: number,
): Promise<{ success: boolean; remaining: number }> {
  const parsed = adjustAllocationSchema.safeParse({ poolId, variantId, delta });

  if (!parsed.success) {
    throw new PoolError("INVALID_INPUT", parsed.error.message);
  }

  return prisma.$transaction(async (tx) => {
    const pool = await tx.inventoryPool.findUnique({
      where: { id: poolId },
      include: { variants: true },
    });

    if (!pool) {
      throw new PoolError("POOL_NOT_FOUND", "Inventory pool not found.");
    }

    const variant = pool.variants.find((item) => item.variantId === variantId);

    if (!variant) {
      throw new PoolError("VARIANT_NOT_IN_POOL", "Variant does not belong to this inventory pool.");
    }

    const totalAllocatedCurrent = pool.variants.reduce(
      (total, item) => total + item.allocatedQty,
      0,
    );

    if (variant.allocatedQty + delta < 0) {
      throw new PoolError(
        "INSUFFICIENT_INVENTORY",
        "Allocation cannot become negative.",
      );
    }

    const nextTotalAllocated = totalAllocatedCurrent + delta;
    if (nextTotalAllocated > pool.totalQty) {
      throw new PoolError(
        "INSUFFICIENT_INVENTORY",
        "Requested allocation exceeds the shared inventory quantity.",
      );
    }

    await tx.inventoryPoolVariant.update({
      where: { id: variant.id },
      data: { allocatedQty: { increment: delta } },
    });

    const updatedPool = await tx.inventoryPool.findUnique({
      where: { id: poolId },
      include: { variants: true },
    });

    if (!updatedPool) {
      throw new PoolError("POOL_NOT_FOUND", "Inventory pool not found after update.");
    }

    return {
      success: true,
      remaining: updatedPool.totalQty - nextTotalAllocated,
    };
  });
}

export async function getPoolReport(poolId: string): Promise<{
  total: number;
  allocated: number;
  remaining: number;
  variants: {
    variantId: string;
    title: string;
    sku: string | null;
    allocated: number;
    remaining: number;
  }[];
}> {
  const pool = await prisma.inventoryPool.findUnique({
    where: { id: poolId },
    include: { variants: true },
  });

  if (!pool) {
    throw new PoolError("POOL_NOT_FOUND", "Inventory pool not found.");
  }

  const allocated = pool.variants.reduce(
    (total, variant) => total + variant.allocatedQty,
    0,
  );

  return {
    total: pool.totalQty,
    allocated,
    remaining: Math.max(0, pool.totalQty - allocated),
    variants: pool.variants.map((variant) => ({
      variantId: variant.variantId,
      title: variant.variantId,
      sku: null,
      allocated: variant.allocatedQty,
      remaining: variant.allocatedQty,
    })),
  };
}


import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getPool, createPool, getPoolReport, PoolError } from "../utils/inventory-pool.server";
import { z } from "zod";

const productIdSchema = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const productId = productIdSchema.safeParse(params.productId);

  if (!productId.success) {
    throw new Response("Invalid product ID", { status: 400 });
  }

  const response = await admin.graphql(
    `#graphql
      query InventoryPoolProduct($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
              }
            }
          }
        }
      }`,
    { variables: { id: productId.data } },
  );

  const result = await response.json();
  const product = result.data?.product;

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  const pool = await getPool(session.shop, product.id);
  const report = pool ? await getPoolReport(pool.id) : null;

  return {
    product,
    pool,
    report,
    variants: product.variants.edges.map(
      (edge: { node: { id: string; title: string; sku: string | null } }) => edge.node,
    ),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const parsedProductId = productIdSchema.safeParse(params.productId);

  if (!parsedProductId.success) {
    throw new Response("Invalid product ID", { status: 400 });
  }

  const formData = await request.formData();
  const input = z.object({
    totalQty: z.coerce.number().int().nonnegative(),
    variantIds: z.array(z.string().min(1)).min(1),
  }).safeParse({
    totalQty: formData.get("totalQty"),
    variantIds: formData.getAll("variantIds"),
  });

  if (!input.success) {
    return { error: "Enter a valid quantity and select at least one variant." };
  }

  const response = await admin.graphql(
    `#graphql
      query ValidateInventoryPoolVariants($id: ID!) {
        product(id: $id) {
          id
          variants(first: 100) {
            edges {
              node { id }
            }
          }
        }
      }`,
    { variables: { id: parsedProductId.data } },
  );

  const result = await response.json();
  const product = result.data?.product;

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  const validVariantIds = new Set(
    product.variants.edges.map((edge: { node: { id: string } }) => edge.node.id),
  );

  if (input.data.variantIds.some((id) => !validVariantIds.has(id))) {
    return { error: "One or more variants do not belong to this product." };
  }

  try {
    await createPool(
      session.shop,
      product.id,
      input.data.totalQty,
      input.data.variantIds,
    );

    return { success: true };
  } catch (error) {
    if (error instanceof PoolError) {
      return { error: error.message };
    }
    throw error;
  }
}

export default function InventoryPoolPage() {
  const { product, pool, report, variants } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading={`Inventory Pool: ${product.title}`}>
      <s-section heading="Create Inventory Pool">
        {pool ? (
          <s-banner tone="success">
            An inventory pool already exists for this product.
          </s-banner>
        ) : (
          <Form method="post">
            <s-stack direction="block" gap="base">
  <s-text-field
  label="Total shared quantity"
  name="totalQty"
  required
/>

              <s-text>Select variants included in this pool:</s-text>

              {variants.map((variant: { id: string; title: string; sku: string | null }) => (
                <s-checkbox
                  key={variant.id}
                  name="variantIds"
                  value={variant.id}
                  label={`${variant.title}${variant.sku ? ` — ${variant.sku}` : ""}`}
                  checked
                />
              ))}

              <s-button variant="primary" type="submit">
                Create Inventory Pool
              </s-button>
            </s-stack>
          </Form>
        )}

        {actionData?.error && (
          <s-banner tone="critical">{actionData.error}</s-banner>
        )}

        {actionData?.success && (
          <s-banner tone="success">
            Pool created. Refresh the page to view its details.
          </s-banner>
        )}
      </s-section>

      {report && (
        <s-section heading="Inventory Summary">
          <s-stack direction="block" gap="base">
            <s-text>Total: {report.total}</s-text>
            <s-text>Allocated: {report.allocated}</s-text>
            <s-text>Remaining: {report.remaining}</s-text>

            {report.variants.map((variant) => (
              <s-box key={variant.variantId} padding="base" borderWidth="base">
                <s-stack direction="block" gap="small">
                  <s-text>{variant.title}</s-text>
                  <s-text>Allocated: {variant.allocated}</s-text>
                  <s-text>Remaining: {variant.remaining}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
